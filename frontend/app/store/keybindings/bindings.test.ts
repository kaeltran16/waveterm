// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { launchPiTab } from "@/app/cockpit/cockpit-actions";
import { RESMON_UI_INITIAL } from "@/app/cockpit/resmon";
import { resmonOpenAtom, resmonSnapshotAtom, resmonUiAtom } from "@/app/cockpit/resmonstore";
import { globalStore } from "@/app/store/jotaiStore";
import { SURFACE_ORDER, type SurfaceKey } from "@/app/view/agents/agents";
import { cheatsheetOpenAtom } from "@/app/cockpit/shortcuts-cheatsheet";
import { escapeMenusOpenAtom } from "@/app/hook/useEscapeClose";
import { atom, type PrimitiveAtom } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shellTaskPeekAtom } from "@/app/view/agents/shelltasksstore";
import { focusSubagentAtom } from "@/app/view/agents/subagentsstore";
import { activeChannelRunsAtom } from "@/app/view/agents/channelsstore";
import {
    attachCanvas,
    detachCanvas,
    getCanvas,
    setCanvasMode,
    setMark,
    setMarking,
    updateCanvas,
} from "@/app/view/agents/canvasstore";
import {
    attachBrainstorm,
    detachBrainstorm,
    getBrainstorm,
    openBrainstormBoard,
    openBrainstormDesign,
    setBrainstormMode,
    setReviewCursor,
    updateBrainstorm,
} from "@/app/view/agents/brainstormstore";
import { getProcExitAtom } from "@/app/view/agents/agentcontrollerstore";
import { sendBrainstorm } from "@/app/view/agents/brainstormsend";
import type { BrainstormFile } from "@/app/view/agents/brainstormmodel";
import { gotoChange } from "@/app/view/agents/diffnav";
import { ignoreWsAtom, splitViewAtom } from "@/app/view/agents/diffoptions";
import { diffScopeAtom } from "@/app/view/agents/diffscopeatom";
import { docReviewAtom } from "@/app/view/agents/docreview";
import { graphOnAtom, historyFiltersAtom, historyScrollAtom } from "@/app/view/agents/githistorystore";
import { NO_FILTERS } from "@/app/view/agents/historyquery";
import { activeReviewAtom } from "@/app/view/agents/reviewmarks";
import { railVisibleAtom, terminalFullscreenAtom } from "@/app/view/agents/railstore";
import { renamingRowAtom } from "@/app/view/agents/rowrenameatom";
import { autonomyPanelOpenAtom } from "@/app/view/jarvis/autonomyladder";
import { finalShotsViewerOpenAtom } from "@/app/view/jarvis/finalshotsstore";
import {
    graphPeekOpenAtom,
    briefPeekRecordAtom,
    chunkMoveAtom,
    noteChunkAtom,
    trackerMenuAtom,
} from "@/app/view/jarvis/jarvisstore";
import { activeRunIdAtom, activeSubjectAtom } from "@/app/view/jarvis/jarvissubjectstore";
import { peekTarget } from "@/app/view/jarvis/openref";
import { itemKeyCommand } from "@/app/view/jarvis/peekitemmodel";
import { petPeekOpenAtom } from "@/app/view/jarvis/petstore";
import { peekKeyCommand } from "@/app/view/jarvis/petpeekmodel";
import { dagModalStateAtom } from "@/app/view/orchestrate/dagmodalstate";
import {
    codeCursorAtom,
    caretWord,
    codeIndexAtom,
    codeTreeFocusedAtom,
    findReferences,
    goToDefinition,
    startCreate,
} from "@/app/view/code/codestore";
import { codeSearchModeAtom } from "@/app/view/code/codesearchstore";
import {
    buildAgentBindings,
    buildChannelsAskBindings,
    buildCockpitBindings,
    buildCodeBindings,
    buildFilesBindings,
    buildFinalShotsBindings,
    buildGlobalBindings,
    buildJarvisBindings,
    buildJarvisGraphBindings,
    buildListNavBindings,
    buildResMonBindings,
    closeTargetForDoubleCtrlC,
} from "./bindings";
import { listNavAtom } from "./listnav";
import { matchBinding } from "./matcher";
import type { KeyContext } from "./types";

vi.mock("@/app/view/jarvis/openref", async (orig) => ({
    ...(await orig<typeof import("@/app/view/jarvis/openref")>()),
    peekTarget: vi.fn(async () => ({ ok: true })),
}));

// the launch, diff-navigation and create-row functions reach for the backend and the mounted editor
vi.mock("@/app/cockpit/cockpit-actions", async (orig) => ({
    ...(await orig<typeof import("@/app/cockpit/cockpit-actions")>()),
    launchPiTab: vi.fn(async () => {}),
}));
vi.mock("@/app/view/agents/brainstormsend", async (orig) => ({
    ...(await orig<typeof import("@/app/view/agents/brainstormsend")>()),
    sendBrainstorm: vi.fn(async () => {}),
}));
vi.mock("@/app/view/agents/diffnav", async (orig) => ({
    ...(await orig<typeof import("@/app/view/agents/diffnav")>()),
    gotoChange: vi.fn(() => true),
}));
vi.mock("@/app/view/code/codestore", async (orig) => ({
    ...(await orig<typeof import("@/app/view/code/codestore")>()),
    startCreate: vi.fn(),
    caretWord: vi.fn(() => null),
    goToDefinition: vi.fn(async () => false),
    findReferences: vi.fn(async () => {}),
}));

// the canvas guards read the focused agent id from the model
const stubModel = (focusId?: string): any => ({
    focusIdAtom: atom<string | undefined>(focusId) as PrimitiveAtom<string | undefined>,
});

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
    it("cycles SURFACE_ORDER forward/back with wrap", () => {
        const model = { surfaceAtom: atom<SurfaceKey>("cockpit") } as any;
        const bindings = buildGlobalBindings(model);
        const next = bindings.find((b) => b.id === "surface:next")!;
        const prev = bindings.find((b) => b.id === "surface:prev")!;
        expect(next.keys).toBe("]");
        expect(prev.keys).toBe("[");

        next.run(ctx()); // cockpit -> jarvis
        expect(globalStore.get(model.surfaceAtom)).toBe("jarvis");

        globalStore.set(model.surfaceAtom, "sessions");
        next.run(ctx()); // sessions -> usage
        expect(globalStore.get(model.surfaceAtom)).toBe("usage");

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

    it("binds nothing to g r", () => {
        const model = { surfaceAtom: atom<SurfaceKey>("cockpit") } as any;
        expect(buildGlobalBindings(model).find((x) => x.keys === "g r")).toBeUndefined();
    });
});

describe("Escape back to the Cockpit", () => {
    const backHome = () =>
        buildGlobalBindings({ surfaceAtom: atom<SurfaceKey>("jarvis") } as any).find(
            (b) => b.id === "surface:back-home"
        )!;

    afterEach(() => globalStore.set(escapeMenusOpenAtom, 0));

    it("leaves a deep surface, but is not bound on the Cockpit itself", () => {
        globalStore.set(graphPeekOpenAtom, false);
        globalStore.set(autonomyPanelOpenAtom, false);
        const b = backHome();
        expect(b.keys).toBe("Escape");
        expect(b.when!(ctx("jarvis"))).toBe(true);
        expect(b.when!(ctx("cockpit"))).toBe(false);
    });

    // an overlay that dismisses on Escape must also suppress this, or one press does both: closes the
    // overlay AND leaves the surface. The dispatcher runs on window capture, so the overlay cannot win
    // the key by registering its own handler — it has to be declared here.
    it("yields to whichever Jarvis overlay owns Escape", () => {
        const b = backHome();
        globalStore.set(graphPeekOpenAtom, true);
        expect(b.when!(ctx("jarvis"))).toBe(false);
        globalStore.set(graphPeekOpenAtom, false);
        globalStore.set(autonomyPanelOpenAtom, true);
        expect(b.when!(ctx("jarvis"))).toBe(false);
        globalStore.set(autonomyPanelOpenAtom, false);
        expect(b.when!(ctx("jarvis"))).toBe(true);
    });

    // the pet lives in window chrome, so unlike the two above its peek can be open on ANY deep surface
    it("yields to the pet's peek on every deep surface it can be open over", () => {
        const b = backHome();
        globalStore.set(petPeekOpenAtom, true);
        expect(b.when!(ctx("jarvis"))).toBe(false);
        expect(b.when!(ctx("files"))).toBe(false);
        expect(b.when!(ctx("usage"))).toBe(false);
        globalStore.set(petPeekOpenAtom, false);
        expect(b.when!(ctx("usage"))).toBe(true);
    });

    // the project-switcher dropdowns close on Escape through useEscapeClose, a window bubble listener the
    // capture-phase dispatcher would starve if this binding ran first
    it("yields to an open useEscapeClose menu on every deep surface", () => {
        const b = backHome();
        globalStore.set(escapeMenusOpenAtom, 1);
        expect(b.when!(ctx("files"))).toBe(false);
        expect(b.when!(ctx("code"))).toBe(false);
        globalStore.set(escapeMenusOpenAtom, 0);
        expect(b.when!(ctx("files"))).toBe(true);
    });

    // The Brief mounts two overlays that take Escape themselves and were missing from this list, so one
    // press both closed the overlay and left the surface — and because the overlay's owner state was never
    // cleared, returning to the Brief showed it open again. The peek is the Brief's only record
    // destination, and the DAG modal is reachable from its run sheet.
    it("yields to the Brief's record peek and DAG modal", () => {
        const b = backHome();
        globalStore.set(graphPeekOpenAtom, false);
        globalStore.set(autonomyPanelOpenAtom, false);
        globalStore.set(petPeekOpenAtom, false);
        globalStore.set(briefPeekRecordAtom, "task-a");
        expect(b.when!(ctx("jarvis"))).toBe(false);
        globalStore.set(briefPeekRecordAtom, null);
        globalStore.set(dagModalStateAtom, {
            kind: "live",
            channelId: "ch-1",
            runId: "run-1",
            dagOref: "dag:run-1",
            error: "",
        });
        expect(b.when!(ctx("jarvis"))).toBe(false);
        globalStore.set(dagModalStateAtom, null);
        expect(b.when!(ctx("jarvis"))).toBe(true);
    });
});

// the capture-phase dispatcher stops propagation when a binding runs, so useEscapeClose's bubble listener
// only sees Escape if every binding that could be live under the menu stands down while one is open
describe("Escape bindings yield to an open useEscapeClose menu", () => {
    const base = { editable: false, modalOpen: false, leader: null };
    const agentCtx: KeyContext = { ...base, surface: "agent" };
    const filesCtx: KeyContext = { ...base, surface: "files" };
    const jarvisCtx: KeyContext = { ...base, surface: "jarvis" };
    const compare = {
        repo: { origin: { kind: "agent", id: "a1" }, label: "a1" },
        range: { kind: "compare", base: "main", head: "feat", form: "mergebase", from: { kind: "working" } },
    } as any;

    afterEach(() => {
        globalStore.set(escapeMenusOpenAtom, 0);
        globalStore.set(focusSubagentAtom, null);
        globalStore.set(shellTaskPeekAtom, null);
        globalStore.set(historyFiltersAtom, NO_FILTERS);
        globalStore.set(diffScopeAtom, null);
        globalStore.set(noteChunkAtom, null);
        globalStore.set(trackerMenuAtom, null);
    });

    // arranges the state that makes the binding live, then shows the menu alone flips it off and back on
    const yields = (when: (ctx: KeyContext) => boolean, c: KeyContext) => {
        globalStore.set(escapeMenusOpenAtom, 0);
        expect(when(c)).toBe(true);
        globalStore.set(escapeMenusOpenAtom, 1);
        expect(when(c)).toBe(false);
        globalStore.set(escapeMenusOpenAtom, 0);
        expect(when(c)).toBe(true);
    };

    it("agent:back", () => {
        const b = buildAgentBindings(stubModel()).find((x) => x.id === "agent:back")!;
        yields(b.when!, agentCtx);
    });

    it("subagent:back", () => {
        globalStore.set(focusSubagentAtom, { parentId: "p", agentId: "s" } as any);
        const b = buildAgentBindings(stubModel()).find((x) => x.id === "subagent:back")!;
        yields(b.when!, agentCtx);
    });

    it("shelltask:back", () => {
        globalStore.set(shellTaskPeekAtom, { parentId: "p", taskId: "t" });
        const b = buildAgentBindings(stubModel()).find((x) => x.id === "shelltask:back")!;
        yields(b.when!, agentCtx);
    });

    it("files:clear-filters", () => {
        globalStore.set(historyFiltersAtom, { author: "dana", path: "", text: "" });
        const b = buildFilesBindings().find((x) => x.id === "files:clear-filters")!;
        yields(b.when!, filesCtx);
    });

    it("files:exit-compare", () => {
        globalStore.set(diffScopeAtom, compare);
        const b = buildFilesBindings().find((x) => x.id === "files:exit-compare")!;
        yields(b.when!, filesCtx);
    });

    it("jarvis:close-notes", () => {
        globalStore.set(noteChunkAtom, "chunk-1");
        const b = buildJarvisBindings().find((x) => x.id === "jarvis:close-notes")!;
        yields(b.when!, jarvisCtx);
    });

    it("jarvis:close-tracker-menu", () => {
        globalStore.set(trackerMenuAtom, "menu-1");
        const b = buildJarvisBindings().find((x) => x.id === "jarvis:close-tracker-menu")!;
        yields(b.when!, jarvisCtx);
    });
});

describe("list-nav bindings", () => {
    const chanCtx: KeyContext = { surface: "jarvis", editable: false, modalOpen: false, leader: null };

    it("is inactive with no controller, when editable/modal, or on a mismatched surface", () => {
        globalStore.set(listNavAtom, null);
        const j = buildListNavBindings(stubModel()).find((b) => b.id === "list:next-j")!;
        expect(j.keys).toBe("j");
        expect(j.when!(chanCtx)).toBe(false); // no controller

        globalStore.set(listNavAtom, { surface: "jarvis", navigableIds: ["a", "b"], cursorId: "a", setCursor() {} });
        expect(j.when!(chanCtx)).toBe(true);
        expect(j.when!({ ...chanCtx, editable: true })).toBe(false);
        expect(j.when!({ ...chanCtx, modalOpen: true })).toBe(false);
        expect(j.when!({ ...chanCtx, surface: "usage" })).toBe(false); // controller is for jarvis
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
        const bindings = buildListNavBindings(stubModel());
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
        buildListNavBindings(stubModel()).find((b) => b.id === "list:next-j")!.run(chanCtx);
        expect(seen).toEqual(["a"]);
        globalStore.set(listNavAtom, null);
    });

    describe("list:peek", () => {
        const run = { kind: "run", runId: "r1" } as const;
        const publish = (peekTarget?: () => typeof run | null) =>
            globalStore.set(listNavAtom, {
                surface: "jarvis",
                navigableIds: ["a"],
                cursorId: "a",
                setCursor() {},
                peekTarget,
            });
        afterEach(() => {
            globalStore.set(listNavAtom, null);
            vi.mocked(peekTarget).mockClear();
        });

        it("is bound to Space and inactive without a peekTarget, when it returns null, in a field, or under a modal", () => {
            const model = stubModel();
            const b = buildListNavBindings(model).find((x) => x.id === "list:peek")!;
            expect(b.keys).toBe("Space");
            publish();
            expect(b.when!(chanCtx)).toBe(false);
            publish(() => null);
            expect(b.when!(chanCtx)).toBe(false);
            publish(() => run);
            expect(b.when!({ ...chanCtx, editable: true })).toBe(false);
            expect(b.when!({ ...chanCtx, modalOpen: true })).toBe(false);
            expect(b.when!(chanCtx)).toBe(true);
        });

        it("peeks the cursor row's target", () => {
            const model = stubModel();
            publish(() => run);
            const peek = buildListNavBindings(model).find((x) => x.id === "list:peek")!;
            peek.run(chanCtx);
            expect(peekTarget).toHaveBeenCalledWith(model, run);
        });
    });
});

describe("jarvis surface bindings", () => {
    const jarvisCtx: KeyContext = { surface: "jarvis", editable: false, modalOpen: false, leader: null };
    const byId = (id: string) => buildJarvisBindings().find((b) => b.id === id)!;

    // The Brief mounts no Stage, so it registers only the graph shortcut (buildJarvisGraphBindings).
    // Sharing one builder rather than re-declaring the key is what keeps the chord from drifting apart
    // between the two compositions.
    it("exposes the graph shortcut on its own, without the Stage-only keys", () => {
        const graphOnly = buildJarvisGraphBindings();
        expect(graphOnly.map((b) => b.id)).toEqual(["jarvis:graph-peek"]);
        const shared = graphOnly[0];
        const fromFull = byId("jarvis:graph-peek");
        expect(shared.keys).toBe(fromFull.keys);
        // the Stage-only keys act on panes the Brief does not have
        expect(graphOnly.some((b) => b.id === "jarvis:toggle-rail" || b.id === "jarvis:new-run")).toBe(false);
    });

    // the click-through bindings (+ Channel, the record band) and composer focus act on rendered DOM, so
    // only their guards are asserted here — this suite runs in node, and the surface has no render harness
    // (see docs: surface behaviour is checked over CDP, not jsdom).
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

    it("suppresses the surface keys while the graph peek owns the surface", () => {
        globalStore.set(graphPeekOpenAtom, true);
        for (const id of ["jarvis:new-run", "jarvis:record-band", "jarvis:next-run"]) {
            expect(byId(id).when!(jarvisCtx)).toBe(false);
        }
        globalStore.set(graphPeekOpenAtom, false);
        expect(byId("jarvis:new-run").when!(jarvisCtx)).toBe(true);
    });

    // the Brief's filter takes / the way the Diff history's does, on its own surface
    it("focuses the Brief filter with /", () => {
        globalStore.set(graphPeekOpenAtom, false);
        const f = byId("jarvis:filter");
        expect(f.keys).toBe("/");
        expect(f.when!(jarvisCtx)).toBe(true);
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
        globalStore.set(activeSubjectAtom, { kind: "dossier", id: "d1" });
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
        const bindings = buildAgentBindings(stubModel());
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

    // subagent:back is the one Escape on this surface that fires while a field has focus, so it is the
    // one that can steal Escape from an open rename box. Escape there means cancel the edit, and the
    // dispatcher runs on window capture — if this binding claims the key the input never sees it, and
    // the box commits on the following blur instead of discarding.
    it("yields Escape to an open row rename, even with a subagent focused", () => {
        const sub = buildAgentBindings(stubModel()).find((b) => b.id === "subagent:back")!;
        const editingCtx: KeyContext = { surface: "agent", editable: true, modalOpen: false, leader: null };
        globalStore.set(focusSubagentAtom, { parentId: "p", agentId: "s" } as any);

        expect(sub.when!(editingCtx)).toBe(true); // fires while editable — that is the whole problem
        globalStore.set(renamingRowAtom, "tab-1");
        expect(sub.when!(editingCtx)).toBe(false);

        globalStore.set(renamingRowAtom, null);
        expect(sub.when!(editingCtx)).toBe(true);
        globalStore.set(focusSubagentAtom, null);
    });
});

describe("shell task peek vs agent Escape", () => {
    it("routes Escape to shelltask-back only while a task's output peek is open, else to agent-back", () => {
        const bindings = buildAgentBindings(stubModel());
        const task = bindings.find((b) => b.id === "shelltask:back")!;
        const back = bindings.find((b) => b.id === "agent:back")!;
        expect(task.keys).toBe("Escape");
        const agentCtx: KeyContext = { surface: "agent", editable: false, modalOpen: false, leader: null };

        globalStore.set(shellTaskPeekAtom, { parentId: "p", taskId: "t" });
        expect(task.when!(agentCtx)).toBe(true);
        expect(back.when!(agentCtx)).toBe(false);
        task.run(agentCtx);
        expect(globalStore.get(shellTaskPeekAtom)).toBeNull();

        expect(task.when!(agentCtx)).toBe(false);
        expect(back.when!(agentCtx)).toBe(true);
    });

    it("fires from the terminal's focus but yields to an open modal and an open row rename", () => {
        const task = buildAgentBindings(stubModel()).find((b) => b.id === "shelltask:back")!;
        const editingCtx: KeyContext = { surface: "agent", editable: true, modalOpen: false, leader: null };
        globalStore.set(shellTaskPeekAtom, { parentId: "p", taskId: "t" });

        expect(task.when!(editingCtx)).toBe(true);
        expect(task.when!({ ...editingCtx, modalOpen: true })).toBe(false);
        globalStore.set(renamingRowAtom, "tab-1");
        expect(task.when!(editingCtx)).toBe(false);

        globalStore.set(renamingRowAtom, null);
        globalStore.set(shellTaskPeekAtom, null);
    });
});

describe("brainstorm pane Escape", () => {
    const nav: KeyContext = { surface: "agent", editable: false, modalOpen: false, leader: null };
    const q = { n: 5, text: "Which layout?", part: "layout" };
    const asking: BrainstormFile = {
        v: 1,
        title: "On-call",
        spec: "",
        question: q,
        working: null,
        parts: [{ id: "layout", title: "Layout", state: "asked", body: "" }],
        history: [],
        done: false,
        check: null,
        run: null,
    };
    let model: any;
    const all = () => [...buildGlobalBindings(model), ...buildListNavBindings(model), ...buildAgentBindings(model)];
    const back = () => all().find((b) => b.id === "agent:brainstorm-back")!;
    const claiming = (c: KeyContext = nav) =>
        all()
            .filter((b) => b.keys === "Escape" && b.when?.(c) !== false)
            .map((b) => b.id);
    const pane = () => {
        const s = getBrainstorm("a1")!;
        return { board: s.board, designOpen: s.designOpen };
    };

    beforeEach(() => {
        vi.stubGlobal("document", { activeElement: null });
        model = {
            ...stubModel("a1"),
            surfaceAtom: atom<SurfaceKey>("agent"),
            agentsAtom: atom<any[]>([{ id: "a1", name: "Agent", blockId: "b1" }]),
        };
        attachBrainstorm("a1", { topic: "oncall", cwd: "C:\\p" }, 0);
        updateBrainstorm("a1", (s) => ({ ...s, file: asking }));
        setBrainstormMode("a1", "brainstorm", 1);
    });

    afterEach(() => {
        detachBrainstorm("a1");
        detachCanvas("a1");
        globalStore.set(escapeMenusOpenAtom, 0);
        globalStore.set(focusSubagentAtom, null);
        globalStore.set(shellTaskPeekAtom, null);
        vi.unstubAllGlobals();
    });

    it("a board opened full size from the question: Esc goes back to the question, and is the only Escape claim", () => {
        openBrainstormBoard("a1", "Split.dc.html");
        expect(claiming()).toEqual(["agent:brainstorm-back"]);
        back().run(nav);
        expect(pane()).toEqual({ board: null, designOpen: false });
        // the question is the top: nothing claims Esc there, as before
        expect(claiming()).toEqual([]);
    });

    it("one level per press: a board opened off the design goes back to the design, and the design back to the question", () => {
        openBrainstormDesign("a1", true);
        openBrainstormBoard("a1", "Split.dc.html");
        back().run(nav);
        expect(pane()).toEqual({ board: null, designOpen: true });
        expect(back().when!(nav)).toBe(true);
        back().run(nav);
        expect(pane()).toEqual({ board: null, designOpen: false });
        expect(back().when!(nav)).toBe(false);
    });

    it("the design opened with no question under it has no step back, unless a builder check is pending under it", () => {
        updateBrainstorm("a1", (s) => ({ ...s, file: { ...asking, question: null }, designOpen: true }));
        expect(back().when!(nav)).toBe(false);
        globalStore.set(model.agentsAtom, [
            { id: "a1", name: "Agent", blockId: "b1", builderCheck: { state: "reading", ts: 2 } },
        ]);
        expect(back().when!(nav)).toBe(true);
    });

    it("yields to a focused field, an open modal and an open escape menu", () => {
        openBrainstormBoard("a1", "Split.dc.html");
        // the answer box, a row's edit or rename, the builder-check answer and the mark note are all fields
        expect(back().when!({ ...nav, editable: true })).toBe(false);
        expect(back().when!({ ...nav, modalOpen: true })).toBe(false);
        globalStore.set(escapeMenusOpenAtom, 1);
        expect(back().when!(nav)).toBe(false);
        globalStore.set(escapeMenusOpenAtom, 0);
        expect(back().when!(nav)).toBe(true);
    });

    it("on the board, a drawn mark's note owns Esc (it drops the mark), even with its field unfocused", () => {
        attachCanvas("a1", { topic: "oncall", dir: "C:\\p\\d", projectDir: "C:\\p", board: "Split.dc.html" }, 0);
        openBrainstormBoard("a1", "Split.dc.html");
        setMarking("a1", true);
        expect(back().when!(nav)).toBe(true);
        setMark("a1", { x: 1, y: 1, w: 40, h: 40, note: "" });
        expect(back().when!(nav)).toBe(false);
        setMark("a1", null);
        expect(back().when!(nav)).toBe(true);
    });

    it("stands down in the terminal, and while a subagent or a shell task peek holds Escape", () => {
        openBrainstormBoard("a1", "Split.dc.html");
        setBrainstormMode("a1", "terminal", 2);
        expect(back().when!(nav)).toBe(false);
        setBrainstormMode("a1", "brainstorm", 3);
        globalStore.set(focusSubagentAtom, { parentId: "a1", agentId: "s" } as any);
        expect(claiming()).toEqual(["subagent:back"]);
        globalStore.set(focusSubagentAtom, null);
        globalStore.set(shellTaskPeekAtom, { parentId: "a1", taskId: "t" });
        expect(claiming()).toEqual(["shelltask:back"]);
    });
});

describe("diff-surface history bindings", () => {
    const ctx = { surface: "files", editable: false, modalOpen: false } as KeyContext;
    const find = (id: string) => buildFilesBindings().find((b) => b.id === id)!;

    beforeEach(() => {
        globalStore.set(historyFiltersAtom, NO_FILTERS);
        globalStore.set(diffScopeAtom, null);
        globalStore.set(graphOnAtom, true);
    });

    it("toggles the graph on Shift+g — bare 'g' is the leader key", () => {
        const b = find("files:toggle-graph");
        expect(b.keys).toBe("Shift:g");
        expect(b.when?.(ctx)).toBe(true);
        b.run(ctx);
        expect(globalStore.get(graphOnAtom)).toBe(false);
    });

    it("does not claim the graph or filter keys while compare is on", () => {
        globalStore.set(diffScopeAtom, {
            repo: { origin: { kind: "agent", id: "a1" }, label: "a1" },
            range: { kind: "compare", base: "main", head: "feat", form: "mergebase", from: { kind: "working" } },
        });
        expect(find("files:toggle-graph").when?.(ctx)).toBe(false);
        expect(find("files:filter").when?.(ctx)).toBe(false);
    });

    it("offers clear-filters only when a filter is actually active", () => {
        expect(find("files:clear-filters").when?.(ctx)).toBe(false);
        globalStore.set(historyFiltersAtom, { author: "dana", path: "", text: "" });
        expect(find("files:clear-filters").when?.(ctx)).toBe(true);
    });

    // These two bindings reach for a real element. The suite runs in node with no DOM, so `document`
    // is stubbed per case rather than switching the whole file to jsdom for two lookups.
    afterEach(() => vi.unstubAllGlobals());

    it("passes the filter key through when the field is not on screen", () => {
        vi.stubGlobal("document", { querySelector: () => null });
        expect(find("files:filter").run(ctx)).toBe(false);
    });

    it("scrolls history to the top on the g g chord", () => {
        const container = { scrollTop: 800 };
        vi.stubGlobal("document", { querySelector: () => container });
        globalStore.set(historyScrollAtom, 800);
        const b = find("files:top");
        expect(b.keys).toBe("g g");
        b.run(ctx);
        expect(globalStore.get(historyScrollAtom)).toBe(0);
        expect(container.scrollTop).toBe(0);
    });

    // Unlike the history-only keys above, refresh is scoped to `on` — it must survive into compare,
    // which has no filter row or graph of its own but still shows changes that can go stale.
    it("stays live in compare — refresh is not gated by inHistory/inCompare", () => {
        const b = find("files:refresh");
        expect(b.keys).toBe("r");
        expect(b.when?.(ctx)).toBe(true);
        globalStore.set(diffScopeAtom, {
            repo: { origin: { kind: "agent", id: "a1" }, label: "a1" },
            range: { kind: "compare", base: "main", head: "feat", form: "mergebase", from: { kind: "working" } },
        });
        expect(b.when?.(ctx)).toBe(true);
    });

    it("c enters compare from history and changes the refs inside compare", () => {
        expect(find("files:compare").when?.(ctx)).toBe(true);
        expect(find("files:change-refs").when?.(ctx)).toBe(false);
        globalStore.set(diffScopeAtom, {
            repo: { origin: { kind: "agent", id: "a1" }, label: "a1" },
            range: { kind: "compare", base: "main", head: "feat", form: "mergebase", from: { kind: "working" } },
        });
        expect(find("files:compare").when?.(ctx)).toBe(false);
        expect(find("files:change-refs").when?.(ctx)).toBe(true);
        expect(find("files:change-refs").keys).toBe("c");
    });

    // Review Focus 5: with nothing open, or while typing in the history filter, v must reach the page
    it("v declines with no open file and is off while typing or under a modal", () => {
        globalStore.set(activeReviewAtom, null);
        const b = find("files:toggle-reviewed");
        expect(b.keys).toBe("v");
        expect(b.run(ctx)).toBe(false);
        expect(b.when?.(ctx)).toBe(true);
        expect(b.when?.({ ...ctx, editable: true })).toBe(false);
        expect(b.when?.({ ...ctx, modalOpen: true })).toBe(false);
    });

    it("change-refs declines the key when no ref chip is on screen", () => {
        globalStore.set(diffScopeAtom, {
            repo: { origin: { kind: "agent", id: "a1" }, label: "a1" },
            range: { kind: "compare", base: "main", head: "feat", form: "mergebase", from: { kind: "working" } },
        });
        vi.stubGlobal("document", { querySelector: () => null });
        expect(find("files:change-refs").run(ctx)).toBe(false);
    });
});

describe("command palette chord", () => {
    const build = () => {
        const model = {
            surfaceAtom: atom<SurfaceKey>("cockpit"),
            paletteOpenAtom: atom(false),
        } as any;
        return { model, b: buildGlobalBindings(model).find((x) => x.id === "palette")! };
    };

    it("is Ctrl+P with no `when`, so nothing else can claim the chord", () => {
        const { b } = build();
        expect(b.keys).toBe("Ctrl:p");
        // no guard at all: reachable from inside a text field, and an always-matching binding is
        // what stops WebView2's print dialog from taking the key on unhandled surfaces
        expect(b.when).toBeUndefined();
    });

    // one overlay on every surface; on Code it opens on the Files scope (palette-scope initialNav)
    it("opens the same search on Code as everywhere else", () => {
        for (const surface of ["cockpit", "code"] as const) {
            const { model, b } = build();
            b.run(ctx(surface));
            expect(globalStore.get(model.paletteOpenAtom)).toBe(true);
        }
    });

    it("toggles shut on a second press", () => {
        const { model, b } = build();
        b.run(ctx("code"));
        b.run(ctx("code"));
        expect(globalStore.get(model.paletteOpenAtom)).toBe(false);
    });
});

describe("code surface bindings", () => {
    const find = (id: string) => {
        const b = buildCodeBindings(stubModel()).find((x) => x.id === id);
        if (b == null) {
            throw new Error(`no binding ${id}`);
        }
        return b;
    };
    const code = ctx("code");

    beforeEach(() => {
        globalStore.set(codeSearchModeAtom, "files");
    });
    afterEach(() => vi.unstubAllGlobals());

    // Files have no chord of their own — the single global "palette" binding opens the search on its
    // Files scope here (see "command palette chord" above), so a chord here would be a second,
    // conflicting claim on the same key.
    it("owns no Ctrl+P of its own — the global search binding covers files", () => {
        expect(buildCodeBindings(stubModel()).find((b) => b.keys === "Ctrl:p")).toBeUndefined();
    });

    it("keeps bare-letter refresh out of the editor, while save survives it", () => {
        expect(find("code:refresh").when?.({ ...code, editable: true })).toBe(false);
        expect(find("code:save").when?.({ ...code, editable: true })).toBe(true);
    });

    // The inline name input sits inside the tree, so its focusin bubbles and leaves the tree
    // "focused". Without the !editable gate, Enter here runs tree-activate — it opens the cursor's
    // file and the create/rename never commits.
    it("stands the tree bindings down while the inline name input has focus", () => {
        globalStore.set(codeTreeFocusedAtom, true);
        const typing = { ...code, editable: true };
        for (const id of ["code:tree-activate", "code:new-file", "code:new-folder", "code:rename", "code:delete"]) {
            expect(find(id).when?.(typing), id).toBe(false);
        }
        expect(find("code:tree-activate").when?.(code)).toBe(true);
        globalStore.set(codeTreeFocusedAtom, false);
    });

    it("opens the collapsed sidebar before switching to Search", () => {
        const clicked = vi.fn();
        const focused = vi.fn();
        const opener = { classList: { contains: () => false }, click: clicked, focus: focused };
        vi.stubGlobal("document", { querySelector: vi.fn(() => opener) });
        vi.stubGlobal("window", { requestAnimationFrame: vi.fn() });

        find("code:search").run(code);

        expect(globalStore.get(codeSearchModeAtom)).toBe("search");
        expect(clicked).toHaveBeenCalledOnce();
        expect(focused).toHaveBeenCalledOnce();
    });

    // The pane focuses its input only when it mounts, and nothing remounts it when Search is already
    // the column's mode — so without this the chord from the editor leaves the caret in Monaco.
    it("puts the caret in the search input when Search is already showing", () => {
        const input = { focus: vi.fn(), select: vi.fn() };
        const querySelector = vi.fn((selector: string) => (selector.includes("data-code-search-input") ? input : null));
        vi.stubGlobal("document", { querySelector });
        vi.stubGlobal("window", { requestAnimationFrame: (callback: () => void) => callback() });
        globalStore.set(codeSearchModeAtom, "search");

        find("code:search").run(code);

        expect(input.focus).toHaveBeenCalledOnce();
        expect(input.select).toHaveBeenCalledOnce();
    });

    it("focuses the reachable opener instead of the hidden tree while collapsed", () => {
        const treeFocus = vi.fn();
        const tree = { closest: vi.fn(() => null), focus: treeFocus };
        const openerFocus = vi.fn();
        const opener = { classList: { contains: () => false }, click: vi.fn(), focus: openerFocus };
        const querySelector = vi.fn((selector: string) => (selector.includes("Expand Code sidebar") ? opener : tree));
        vi.stubGlobal("document", { querySelector });
        vi.stubGlobal("window", { requestAnimationFrame: (callback: () => void) => callback() });

        find("code:focus-tree").run(code);

        expect(openerFocus).toHaveBeenCalledOnce();
        expect(treeFocus).toHaveBeenCalledOnce();
    });
});

describe("leader reachability and the fullscreen chord", () => {
    const model = stubModel();
    const inTerm: KeyContext = { surface: "agent", editable: true, modalOpen: false, leader: null };
    const inTermLeader: KeyContext = { ...inTerm, leader: "g" };

    it("registers a documentation-only leader:enter binding on the alias chord", () => {
        const b = buildGlobalBindings(model).find((x) => x.id === "leader:enter")!;
        expect(b).toBeDefined();
        expect(b.keys).toBe("Ctrl:g");
        // documentation only — the matcher performs leader entry, so this must never consume the key
        expect(b.run(inTerm)).toBe(false);
    });

    it("leader:enter is advertised while the terminal holds focus", () => {
        const b = buildGlobalBindings(model).find((x) => x.id === "leader:enter")!;
        expect(b.when?.(inTerm) ?? true).toBe(true);
    });

    it("surface teleports are dormant in the terminal but live under the leader", () => {
        const go = buildGlobalBindings(model).find((x) => x.id === "go:agent")!;
        expect(go.when!(inTerm)).toBe(false);
        expect(go.when!(inTermLeader)).toBe(true);
    });

    it("the details rail is dormant in the terminal but live under the leader", () => {
        const rail = buildAgentBindings(model).find((x) => x.id === "agent:toggle-rail")!;
        expect(rail.when!(inTerm)).toBe(false);
        expect(rail.when!(inTermLeader)).toBe(true);
    });

    it("Escape-keyed navigation stays dormant in BOTH postures (the matcher owns Escape)", () => {
        const back = buildAgentBindings(model).find((x) => x.id === "agent:back")!;
        expect(back.when!(inTerm)).toBe(false);
        expect(back.when!(inTermLeader)).toBe(false);
    });

    it("F11 toggles fullscreen and is live while the terminal holds focus", () => {
        const b = buildAgentBindings(model).find((x) => x.id === "agent:fullscreen-chord")!;
        expect(b.keys).toBe("F11");
        expect(b.when!(inTerm)).toBe(true);
        expect(b.when!({ ...inTerm, surface: "cockpit" })).toBe(false);
    });
});

describe("agent:review", () => {
    const reviewAsk = {
        askId: "a1",
        questions: [{ header: "Spec review", question: "/r/spec.md\n- one", options: [{ label: "Approve" }] }],
    };
    const plainAsk = { askId: "a2", questions: [{ header: "Flake fix", question: "Retry?", options: [] }] };
    const modelFocusing = (id: string) =>
        ({
            focusIdAtom: atom<string>(id),
            agentsAtom: atom([
                { id: "lead", state: "asking", ask: reviewAsk },
                { id: "worker", state: "asking", ask: plainAsk },
            ]),
        }) as any;
    const review = (model: any) => buildAgentBindings(model).find((b) => b.id === "agent:review")!;

    afterEach(() => globalStore.set(docReviewAtom, null));

    it("is r on the Agent surface, off while typing", () => {
        const b = review(modelFocusing("lead"));
        expect(b.keys).toBe("r");
        expect(b.when!(ctx("agent"))).toBe(true);
        expect(b.when!({ ...ctx("agent"), editable: true })).toBe(false);
        expect(b.when!(ctx("cockpit"))).toBe(false);
    });

    it("opens the focused agent's doc review", () => {
        expect(review(modelFocusing("lead")).run(ctx("agent"))).not.toBe(false);
        expect(globalStore.get(docReviewAtom)).toBe("lead");
    });

    it("lets the key pass when the focused agent's ask is not a doc review", () => {
        expect(review(modelFocusing("worker")).run(ctx("agent"))).toBe(false);
        expect(globalStore.get(docReviewAtom)).toBeNull();
    });
});

// remote callers (wsh ui do) must get the user's confirmation for these; the keyboard still runs them directly
describe("destructive bindings", () => {
    it("flags the irreversible actions that do not confirm on their own", () => {
        expect(buildCodeBindings(stubModel()).find((b) => b.id === "code:save")?.destructive).toBe(true);
    });

    it("leaves actions that confirm themselves, or can be undone, unflagged", () => {
        expect(buildCodeBindings(stubModel()).find((b) => b.id === "code:delete")?.destructive).toBeUndefined();
    });
});

describe("agent canvas mode keys", () => {
    const nav: KeyContext = { surface: "agent", editable: false, modalOpen: false, leader: null };
    const inTerm: KeyContext = { ...nav, editable: true };
    let model: any;
    const all = () => [...buildGlobalBindings(model), ...buildAgentBindings(model)];
    const find = (id: string) => all().find((b) => b.id === id)!;
    const active = (id: string, c: KeyContext = nav) => find(id).when!(c);

    beforeEach(() => {
        model = { ...stubModel("a1"), surfaceAtom: atom<SurfaceKey>("agent") };
        attachCanvas("a1", { topic: "t", dir: "C:\\p\\.superpowers\\design\\t", projectDir: "C:\\p" }, 0);
        updateCanvas("a1", (s) => ({
            ...s,
            status: "ready",
            boards: [
                { name: "Main.dc.html", x: 0, y: 0, w: 1440, h: 900 },
                { name: "States.dc.html", x: 0, y: 0, w: 1440, h: 900 },
            ],
        }));
    });

    afterEach(() => {
        detachCanvas("a1");
    });

    it("c opens the canvas from the nav, not with no canvas or from inside the terminal", () => {
        expect(active("agent:canvas-open")).toBe(true);
        expect(active("agent:canvas-open", inTerm)).toBe(false);
        detachCanvas("a1");
        expect(active("agent:canvas-open")).toBe(false);
    });

    it("running c switches the focused agent to canvas mode", () => {
        find("agent:canvas-open").run(nav);
        expect(getCanvas("a1")!.mode).toBe("canvas");
    });

    it("Ctrl+Shift+B toggles the canvas from inside the terminal, and stands down with no canvas", () => {
        expect(find("agent:view-chord").keys).toBe("Ctrl:Shift:b");
        expect(active("agent:view-chord", inTerm)).toBe(true);
        find("agent:view-chord").run(inTerm);
        expect(getCanvas("a1")!.mode).toBe("canvas");
        find("agent:view-chord").run(nav);
        expect(getCanvas("a1")!.mode).toBe("terminal");
        expect(active("agent:view-chord", { ...inTerm, modalOpen: true })).toBe(false);
        detachCanvas("a1");
        expect(active("agent:view-chord", inTerm)).toBe(false);
    });

    it("in canvas mode: c, [ ], m and the agent switches are live; the surface, rail, fullscreen and back keys stand down", () => {
        setCanvasMode("a1", "canvas", 1);
        for (const id of [
            "agent:canvas-close",
            "agent:canvas-prev",
            "agent:canvas-next",
            "agent:mark-start",
            "agent:prev",
            "agent:next",
            "agent:prev-k",
            "agent:next-j",
            "cycle-agent-next",
            "cycle-agent-prev",
        ]) {
            expect(active(id), id).toBe(true);
        }
        expect(active("agent:canvas-open")).toBe(false);
        expect(active("agent:mark-stop")).toBe(false);
        for (const id of [
            "surface:next",
            "surface:prev",
            "agent:toggle-rail",
            "agent:fullscreen",
            "agent:fullscreen-chord",
            "agent:back",
        ]) {
            expect(active(id), id).toBe(false);
        }
    });

    it("the surface switch still works on other surfaces while an agent is in canvas mode", () => {
        setCanvasMode("a1", "canvas", 1);
        expect(active("surface:next", { ...nav, surface: "jarvis" })).toBe(true);
    });

    it("board keys wait for the board to load", () => {
        setCanvasMode("a1", "canvas", 1);
        updateCanvas("a1", (s) => ({ ...s, status: "probing" }));
        expect(active("agent:canvas-next")).toBe(false);
        expect(active("agent:mark-start")).toBe(false);
        expect(active("agent:canvas-close")).toBe(true);
    });

    it("while marking: m stops marking, and the board keys and m-to-mark stand down", () => {
        setCanvasMode("a1", "canvas", 1);
        setMarking("a1", true);
        expect(active("agent:mark-stop")).toBe(true);
        expect(active("agent:mark-start")).toBe(false);
        expect(active("agent:canvas-prev")).toBe(false);
        expect(active("agent:canvas-next")).toBe(false);
        expect(active("agent:canvas-close")).toBe(true);
        find("agent:mark-stop").run(nav);
        expect(getCanvas("a1")!.marking).toBe(false);
    });

    it("] steps to the next board", () => {
        setCanvasMode("a1", "canvas", 1);
        find("agent:canvas-next").run(nav);
        expect(getCanvas("a1")!.board).toBe("States.dc.html");
        find("agent:canvas-prev").run(nav);
        expect(getCanvas("a1")!.board).toBe("Main.dc.html");
    });

    it("m starts marking on a loaded board", () => {
        setCanvasMode("a1", "canvas", 1);
        find("agent:mark-start").run(nav);
        expect(getCanvas("a1")!.marking).toBe(true);
    });

    it("c from canvas mode goes back to the terminal", () => {
        setCanvasMode("a1", "canvas", 1);
        find("agent:canvas-close").run(nav);
        expect(getCanvas("a1")!.mode).toBe("terminal");
    });

    it("another focused agent without canvas mode keeps its keys", () => {
        setCanvasMode("a1", "canvas", 1);
        globalStore.set(model.focusIdAtom, "a2");
        expect(active("agent:toggle-rail")).toBe(true);
        expect(active("surface:next")).toBe(true);
        expect(active("agent:canvas-close")).toBe(false);
        expect(getCanvas("a1")!.mode).toBe("canvas");
    });
});

describe("final shots viewer bindings", () => {
    afterEach(() => globalStore.set(finalShotsViewerOpenAtom, false));

    function build() {
        const calls: string[] = [];
        const bindings = buildFinalShotsBindings({
            scenario: (d) => calls.push(`scenario ${d}`),
            shot: (d) => calls.push(`shot ${d}`),
            zoom: () => calls.push("zoom"),
            steps: () => calls.push("steps"),
            close: () => calls.push("close"),
        });
        return { bindings, calls };
    }

    it("maps the arrows, z, s and Escape onto their handlers", () => {
        const { bindings, calls } = build();
        const byKey = new Map(bindings.map((b) => [b.keys, b]));
        for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "z", "s", "Escape"]) {
            byKey.get(key)!.run(ctx("jarvis"));
        }
        expect(calls).toEqual(["scenario -1", "scenario 1", "shot -1", "shot 1", "zoom", "steps", "close"]);
        expect(bindings).toHaveLength(7);
    });

    it("is active only while the viewer is open, whatever the context says", () => {
        const { bindings } = build();
        expect(bindings.some((b) => b.when!(ctx("jarvis")))).toBe(false);
        globalStore.set(finalShotsViewerOpenAtom, true);
        expect(bindings.every((b) => b.when!({ ...ctx("jarvis"), modalOpen: true }))).toBe(true);
    });
});

// The avatar popup handles its own keys on the panel, but the dispatcher runs on window capture and stops any
// key it claims, so a surface binding live under the popup would take the key from it.
describe("the open avatar popup keeps its keys on every surface", () => {
    const POPUP_KEYS = ["j", "k", "ArrowDown", "ArrowUp", "Enter", " ", "/", "Escape", "Backspace"];
    const key = (k: string) =>
        ({ key: k, code: "", control: false, shift: false, cmd: false, option: false, meta: false, alt: false }) as any;

    afterEach(() => globalStore.set(petPeekOpenAtom, false));

    it("lists only keys the popup acts on", () => {
        for (const k of POPUP_KEYS) {
            expect(peekKeyCommand(k) ?? itemKeyCommand(k), k).not.toBeNull();
        }
    });

    it("leaves every popup key unclaimed, from the panel and from its composer", () => {
        const model = stubModel("agent-tab");
        const all = [
            ...buildGlobalBindings(model),
            ...buildListNavBindings(model),
            ...buildCockpitBindings(),
            ...buildAgentBindings(model),
            ...buildFilesBindings(),
            ...buildCodeBindings(stubModel()),
            ...buildJarvisBindings(),
            ...buildJarvisGraphBindings(),
            ...buildChannelsAskBindings(model, { current: { id: "agent-tab" } as any }),
        ];
        globalStore.set(petPeekOpenAtom, true);
        const claimed: string[] = [];
        for (const surface of SURFACE_ORDER) {
            for (const editable of [false, true]) {
                for (const k of POPUP_KEYS) {
                    const result = matchBinding(key(k), { surface, editable, modalOpen: true, leader: null }, all);
                    if (result.kind === "run") {
                        claimed.push(
                            `${surface} ${editable ? "composer" : "panel"} ${JSON.stringify(k)}: ${result.binding.id}`
                        );
                    }
                }
            }
        }
        expect(claimed).toEqual([]);
    });
});

// The popover is non-modal window chrome over any surface, and the dispatcher runs the first active binding for a
// key, so every surface binding on its keys has to stand down while it is open.
describe("Resource Manager popover bindings", () => {
    const key = (k: string, shift = false) =>
        ({ key: k, code: "", control: false, shift, cmd: false, option: false, meta: false, alt: false }) as any;
    const model = { ...stubModel("agent-tab"), paletteOpenAtom: atom(false) };
    const resmon = buildResMonBindings(model);
    // the popover's bindings last: they must win on the key, not on registration order
    const all = [
        ...buildGlobalBindings(model),
        ...buildListNavBindings(model),
        ...buildAgentBindings(model),
        ...resmon,
    ];
    const onAgent = (modalOpen: boolean): KeyContext => ({
        surface: "agent",
        editable: false,
        modalOpen,
        leader: null,
    });
    const picked = (k: string, c: KeyContext, shift = false) => {
        const r = matchBinding(key(k, shift), c, all);
        return r.kind === "run" ? r.binding.id : r.kind;
    };
    const row = (pid: number, depth: number, tag?: string): ProcessInfo =>
        ({ pid, depth, tag, name: `p${pid}.exe`, cpu: 0, mem: 0, mempct: 0, numthreads: 1 }) as ProcessInfo;
    const snapshot: ResMonSnapshotData = {
        supported: true,
        ready: true,
        ts: 0,
        cpu: 0,
        mem: 0,
        totalmem: 0,
        busycpu: false,
        busymem: false,
        groups: [
            { key: "arc", ownerkind: "arc", label: "Arc", killable: false, cpu: 0, mem: 0, rows: [row(1, 0)] },
            {
                key: "job:10",
                ownerkind: "agenttab",
                label: "waveterm",
                killable: true,
                cpu: 1,
                mem: 0,
                rows: [row(10, 0, "agent"), row(11, 1)],
            },
        ],
    };
    const run = (id: string) => resmon.find((b) => b.id === id)!.run(onAgent(true));

    afterEach(() => {
        globalStore.set(resmonOpenAtom, false);
        globalStore.set(resmonSnapshotAtom, null);
        globalStore.set(resmonUiAtom, RESMON_UI_INITIAL);
        globalStore.set(model.paletteOpenAtom, false);
    });

    it("takes Escape, Enter, ArrowDown and x from the Agent surface while open", () => {
        globalStore.set(resmonOpenAtom, true);
        expect(picked("Escape", onAgent(true))).toBe("resmon:close");
        expect(picked("Enter", onAgent(true))).toBe("resmon:enter");
        expect(picked("ArrowDown", onAgent(true))).toBe("resmon:next");
        expect(picked("ArrowUp", onAgent(true))).toBe("resmon:prev");
        expect(picked("x", onAgent(true))).toBe("resmon:kill");
        expect(picked("X", onAgent(true), true)).toBe("resmon:kill-children");
    });

    it("is inactive while closed, where g m opens it", () => {
        expect(resmon.some((b) => b.when!(onAgent(false)))).toBe(false);
        expect(picked("g", onAgent(false))).toBe("enterLeader");
        expect(picked("m", { ...onAgent(false), leader: "g" })).toBe("go:resmon");
        all.find((b) => b.id === "go:resmon")!.run(onAgent(false));
        expect(globalStore.get(resmonOpenAtom)).toBe(true);
    });

    it("yields to a field, the palette and a modal opened over it", () => {
        globalStore.set(resmonOpenAtom, true);
        expect(resmon.some((b) => b.when!({ ...onAgent(true), editable: true }))).toBe(false);
        globalStore.set(model.paletteOpenAtom, true);
        expect(resmon.some((b) => b.when!(onAgent(true)))).toBe(false);
    });

    it("moves, asks, cancels and closes", () => {
        globalStore.set(resmonSnapshotAtom, snapshot);
        globalStore.set(resmonOpenAtom, true);
        // every view starts collapsed: Arc, then waveterm's header, expanded to reach its member and rows
        run("resmon:next");
        run("resmon:next");
        run("resmon:enter");
        run("resmon:next");
        expect(globalStore.get(resmonUiAtom).cursor).toBe("m:job:10");
        run("resmon:kill"); // the member's own line, the agent: no confirm
        expect(globalStore.get(resmonUiAtom).confirm).toBeNull();
        run("resmon:next");
        run("resmon:kill");
        expect(globalStore.get(resmonUiAtom).confirm).toEqual({ kind: "row", key: "job:10", pid: 11 });
        run("resmon:close");
        expect(globalStore.get(resmonUiAtom).confirm).toBeNull();
        expect(globalStore.get(resmonOpenAtom)).toBe(true);
        run("resmon:kill-children");
        expect(globalStore.get(resmonUiAtom).confirm).toEqual({ kind: "group", key: "job:10" });
        run("resmon:close");
        run("resmon:close");
        expect(globalStore.get(resmonOpenAtom)).toBe(false);
    });

    it("toggles the cursor's group on Enter", () => {
        globalStore.set(resmonSnapshotAtom, snapshot);
        globalStore.set(resmonOpenAtom, true);
        run("resmon:next");
        run("resmon:enter");
        expect(globalStore.get(resmonUiAtom).expanded.arc).toBe(true);
    });
});

describe("global bindings", () => {
    const build = (surface: SurfaceKey = "cockpit", extra: object = {}) => {
        const model = {
            surfaceAtom: atom<SurfaceKey>(surface),
            paletteOpenAtom: atom(false),
            newAgentOpenAtom: atom(false),
            ...extra,
        } as any;
        const bindings = buildGlobalBindings(model);
        return { model, bindings, find: (id: string) => bindings.find((b) => b.id === id)! };
    };
    const at = (surface: SurfaceKey, over: Partial<KeyContext> = {}): KeyContext => ({ ...ctx(surface), ...over });

    // earlier suites leave a compare scope behind, and compare owns Escape
    beforeEach(() => globalStore.set(diffScopeAtom, null));
    afterEach(() => {
        globalStore.set(historyFiltersAtom, NO_FILTERS);
        globalStore.set(noteChunkAtom, null);
        globalStore.set(trackerMenuAtom, null);
        globalStore.set(cheatsheetOpenAtom, false);
        vi.mocked(launchPiTab).mockClear();
    });

    describe("surface cycle", () => {
        const last = SURFACE_ORDER[SURFACE_ORDER.length - 1];

        it("enters from an unlisted surface at the end the direction points away from", () => {
            const { model, find } = build("settings");
            find("surface:prev").run(ctx("settings"));
            expect(globalStore.get(model.surfaceAtom)).toBe(last);
            globalStore.set(model.surfaceAtom, "settings");
            find("surface:next").run(ctx("settings"));
            expect(globalStore.get(model.surfaceAtom)).toBe(SURFACE_ORDER[0]);
        });

        it("steps one place from a listed surface, in the middle of the order", () => {
            const { model, find } = build(SURFACE_ORDER[1]);
            find("surface:next").run(ctx());
            expect(globalStore.get(model.surfaceAtom)).toBe(SURFACE_ORDER[2]);
            globalStore.set(model.surfaceAtom, SURFACE_ORDER[1]);
            find("surface:prev").run(ctx());
            expect(globalStore.get(model.surfaceAtom)).toBe(SURFACE_ORDER[0]);
        });

        it("both switches stand down while typing, under a modal and in the agent's canvas, and are live otherwise", () => {
            const { find } = build();
            for (const id of ["surface:next", "surface:prev"]) {
                const b = find(id);
                expect(b.when!(at("cockpit")), id).toBe(true);
                expect(b.when!(at("cockpit", { editable: true })), id).toBe(false);
                expect(b.when!(at("cockpit", { modalOpen: true })), id).toBe(false);
            }
        });
    });

    it("binds Ctrl+1..n to each surface in rail order, hidden from the palette", () => {
        const { model, bindings } = build();
        const chords = bindings.filter((b) => /^Ctrl:\d$/.test(b.keys));
        expect(chords.map((b) => [b.id, b.keys, b.paletteHidden])).toEqual(
            SURFACE_ORDER.map((s, i) => [`surface:${s}`, `Ctrl:${i + 1}`, true])
        );
        for (const [i, chord] of chords.entries()) {
            globalStore.set(model.surfaceAtom, "settings");
            chord.run(ctx());
            expect(globalStore.get(model.surfaceAtom)).toBe(SURFACE_ORDER[i]);
        }
    });

    it("keeps the rows that would only duplicate another out of the palette", () => {
        const { find } = build();
        for (const id of ["palette", "leader:enter", "go:palette", "close-agent"]) {
            expect(find(id).paletteHidden, id).toBe(true);
        }
    });

    it("advertises the leader chord only while a field holds focus and no modal is open", () => {
        const b = build().find("leader:enter");
        expect(b.when!(at("agent", { editable: true }))).toBe(true);
        expect(b.when!(at("agent", { editable: false }))).toBe(false);
        expect(b.when!(at("agent", { editable: true, modalOpen: true }))).toBe(false);
    });

    it("g p opens the search, and keeps it open on a second press", () => {
        const { model, find } = build();
        find("go:palette").run(ctx());
        find("go:palette").run(ctx());
        expect(globalStore.get(model.paletteOpenAtom)).toBe(true);
    });

    it("Ctrl+N opens the new-agent dialog, but not over another modal", () => {
        const { model, find } = build();
        const b = find("new-agent");
        expect(b.when!(at("cockpit"))).toBe(true);
        expect(b.when!(at("cockpit", { modalOpen: true }))).toBe(false);
        b.run(ctx());
        expect(globalStore.get(model.newAgentOpenAtom)).toBe(true);
    });

    it("Ctrl+Shift+N launches a Pi tab on the model", () => {
        const { model, find } = build();
        find("launch:pi").run(ctx());
        expect(launchPiTab).toHaveBeenCalledWith(model);
    });

    it("the agent cycle and Ctrl+C belong to the Agent surface and drive the model's focus cycle", () => {
        const cycleFocus = vi.fn();
        const { find } = build("agent", { cycleFocus });
        for (const id of ["cycle-agent-next", "cycle-agent-prev", "close-agent"]) {
            expect(find(id).when!(at("agent")), id).toBe(true);
            expect(find(id).when!(at("cockpit")), id).toBe(false);
        }
        find("cycle-agent-next").run(ctx("agent"));
        expect(cycleFocus).toHaveBeenLastCalledWith(false);
        find("cycle-agent-prev").run(ctx("agent"));
        expect(cycleFocus).toHaveBeenLastCalledWith(true);
    });

    it("? opens the cheat sheet", () => {
        build().find("help").run(ctx());
        expect(globalStore.get(cheatsheetOpenAtom)).toBe(true);
    });

    describe("Escape back to the Cockpit", () => {
        const files = at("files");

        it("stands down on the Diff surface only while a history filter is active", () => {
            const b = build().find("surface:back-home");
            expect(b.when!(files)).toBe(true);
            globalStore.set(historyFiltersAtom, { author: "dana", path: "", text: "" });
            expect(b.when!(files)).toBe(false);
            // the filter rule is the Diff surface's own
            expect(b.when!(at("usage"))).toBe(true);
        });

        it("stands down while the Brief's Chunk sidebar or plan menu is open", () => {
            const b = build().find("surface:back-home");
            const jarvis = at("jarvis");
            globalStore.set(noteChunkAtom, "chunk-1");
            expect(b.when!(jarvis)).toBe(false);
            globalStore.set(noteChunkAtom, null);
            globalStore.set(trackerMenuAtom, "menu-1");
            expect(b.when!(jarvis)).toBe(false);
            globalStore.set(trackerMenuAtom, null);
            expect(b.when!(jarvis)).toBe(true);
        });

        it("goes home when no jump brought the user here", () => {
            const { model, find } = build("jarvis");
            find("surface:back-home").run(ctx("jarvis"));
            expect(globalStore.get(model.surfaceAtom)).toBe("cockpit");
        });
    });
});

describe("list-nav bindings, edge cases", () => {
    const chan: KeyContext = { surface: "jarvis", editable: false, modalOpen: false, leader: null };
    const find = (id: string) => buildListNavBindings(stubModel()).find((b) => b.id === id)!;

    afterEach(() => {
        globalStore.set(listNavAtom, null);
        vi.mocked(peekTarget).mockClear();
    });

    it("hides every row from the palette: each is a cursor key, not a command", () => {
        const bindings = buildListNavBindings(stubModel());
        expect(bindings.map((b) => b.id)).toEqual([
            "list:next-j",
            "list:prev-k",
            "list:next",
            "list:prev",
            "list:activate",
            "list:peek",
        ]);
        expect(bindings.map((b) => b.paletteHidden)).toEqual([true, true, true, true, true, true]);
    });

    it("moving with no controller published does nothing", () => {
        globalStore.set(listNavAtom, null);
        expect(find("list:next-j").run(chan)).toBeUndefined();
    });

    it("moving over an empty list leaves the cursor where it is", () => {
        const setCursor = vi.fn();
        globalStore.set(listNavAtom, { surface: "jarvis", navigableIds: [], cursorId: undefined, setCursor });
        find("list:next-j").run(chan);
        expect(setCursor).not.toHaveBeenCalled();
    });

    it("Space declines the key and peeks nothing when the cursor row has no target", () => {
        globalStore.set(listNavAtom, {
            surface: "jarvis",
            navigableIds: ["a"],
            cursorId: "a",
            setCursor() {},
            peekTarget: () => null,
        });
        expect(find("list:peek").run(chan)).toBe(false);
        expect(peekTarget).not.toHaveBeenCalled();
    });
});

describe("Brief answer keys", () => {
    const jarvis: KeyContext = { surface: "jarvis", editable: false, modalOpen: false, leader: null };
    const agent = {
        id: "w1",
        state: "asking",
        ask: { askId: "a1", questions: [{ header: "h", question: "q", options: [{ label: "A" }, { label: "B" }] }] },
    } as any;
    const build = (current: any = agent) => {
        const model = {
            answerTabAtom: atom<Record<string, number>>({}),
            answerSelAtom: atom({}),
            answerTextAtom: atom({}),
            toggleAnswer: vi.fn(),
            submitAnswer: vi.fn(),
        } as any;
        return { model, bindings: buildChannelsAskBindings(model, { current }) };
    };

    it("binds the digits 1 to 9, hidden from the palette, and Enter to submit", () => {
        const { bindings } = build();
        const digits = bindings.slice(0, 9);
        expect(digits.map((b) => [b.id, b.keys, b.paletteHidden])).toEqual(
            Array.from({ length: 9 }, (_, i) => [`channels:answer-${i + 1}`, String(i + 1), true])
        );
        const submit = bindings.find((b) => b.id === "channels:submit")!;
        expect(bindings).toHaveLength(10);
        expect(submit.keys).toBe("Enter");
        expect(submit.paletteHidden).toBe(true);
    });

    it("is live only on the Jarvis surface, out of a field and a modal, with an asking worker published", () => {
        const { bindings } = build();
        const when = bindings[0].when!;
        expect(when(jarvis)).toBe(true);
        expect(when({ ...jarvis, surface: "cockpit" })).toBe(false);
        expect(when({ ...jarvis, editable: true })).toBe(false);
        expect(when({ ...jarvis, modalOpen: true })).toBe(false);
        expect(build(null).bindings[0].when!(jarvis)).toBe(false);
    });

    it("toggles the option the digit names, and lets a digit past the last option pass", () => {
        const { model, bindings } = build();
        bindings[1].run(jarvis);
        expect(model.toggleAnswer).toHaveBeenCalledOnce();
        expect(model.toggleAnswer).toHaveBeenCalledWith("w1", 0, 1);
        expect(bindings[2].run(jarvis)).toBe(false);
        expect(model.toggleAnswer).toHaveBeenCalledOnce();
    });
});

describe("Jarvis keys, the surface's own controls", () => {
    const jarvis: KeyContext = { surface: "jarvis", editable: false, modalOpen: false, leader: null };
    const find = (id: string) => buildJarvisBindings().find((b) => b.id === id)!;

    afterEach(() => {
        vi.unstubAllGlobals();
        globalStore.set(graphPeekOpenAtom, false);
        globalStore.set(noteChunkAtom, null);
        globalStore.set(trackerMenuAtom, null);
        globalStore.set(chunkMoveAtom, null);
        globalStore.set(activeSubjectAtom, null);
        globalStore.set(activeChannelRunsAtom, []);
        globalStore.set(activeRunIdAtom, {});
    });

    it("closing the Chunk sidebar is live only on the Jarvis surface, with a note open and no plan menu", () => {
        const b = find("jarvis:close-notes");
        globalStore.set(noteChunkAtom, "chunk-1");
        expect(b.when!(jarvis)).toBe(true);
        expect(b.when!({ ...jarvis, surface: "cockpit" })).toBe(false);
        globalStore.set(trackerMenuAtom, "menu-1");
        expect(b.when!(jarvis)).toBe(false);
        globalStore.set(trackerMenuAtom, null);
        globalStore.set(noteChunkAtom, null);
        expect(b.when!(jarvis)).toBe(false);
    });

    it("the plan menu's Escape is live only on the Jarvis surface, and closes the menu", () => {
        const b = find("jarvis:close-tracker-menu");
        globalStore.set(trackerMenuAtom, "menu-1");
        expect(b.when!(jarvis)).toBe(true);
        expect(b.when!({ ...jarvis, surface: "cockpit" })).toBe(false);
        b.run(jarvis);
        expect(globalStore.get(trackerMenuAtom)).toBeNull();
    });

    describe("run switching", () => {
        const channel = () => globalStore.set(activeSubjectAtom, { kind: "channel", id: "ch1" });
        const runs = (...rows: [string, string][]) =>
            globalStore.set(
                activeChannelRunsAtom,
                rows.map(([id, status]) => ({ id, status })) as any
            );

        it("passes the key when the subject is not a channel, even if runs are loaded", () => {
            globalStore.set(activeSubjectAtom, { kind: "dossier", id: "d1" });
            runs(["r1", "running"], ["r2", "running"]);
            expect(find("jarvis:next-run").run(jarvis)).toBe(false);
            expect(globalStore.get(activeRunIdAtom)).toEqual({});
        });

        it("passes the key for a lone finished run instead of selecting it", () => {
            channel();
            runs(["r1", "done"]);
            expect(find("jarvis:next-run").run(jarvis)).toBe(false);
            expect(globalStore.get(activeRunIdAtom)).toEqual({});
        });

        it("passes the key at either end of the list, and switches with no result in between", () => {
            channel();
            runs(["r1", "running"], ["r2", "running"]);
            globalStore.set(activeRunIdAtom, { ch1: "r2" });
            expect(find("jarvis:next-run").run(jarvis)).toBe(false);
            expect(find("jarvis:prev-run").run(jarvis)).toBeUndefined();
            expect(globalStore.get(activeRunIdAtom)).toEqual({ ch1: "r1" });
            expect(find("jarvis:prev-run").run(jarvis)).toBe(false);
            expect(globalStore.get(activeRunIdAtom)).toEqual({ ch1: "r1" });
        });
    });

    describe("chunk moves", () => {
        it.each([
            ["jarvis:chunk-up", "up"],
            ["jarvis:chunk-down", "down"],
        ])("%s is live on the Stage only while the sidebar publishes a mover, and calls it with %s", (id, dir) => {
            const b = find(id);
            expect(b.when!(jarvis)).toBe(false);
            const move = vi.fn();
            // a function value would be taken for an updater
            globalStore.set(chunkMoveAtom, () => move);
            expect(b.when!(jarvis)).toBe(true);
            expect(b.when!({ ...jarvis, surface: "cockpit" })).toBe(false);
            globalStore.set(graphPeekOpenAtom, true);
            expect(b.when!(jarvis)).toBe(false);
            b.run(jarvis);
            expect(move).toHaveBeenCalledOnce();
            expect(move).toHaveBeenCalledWith(dir);
        });
    });

    describe("click-through keys", () => {
        it.each([
            ["jarvis:new-run", "[data-new-run]"],
            ["jarvis:new-initiative", "[data-jarvis-new-initiative]"],
            ["jarvis:work-on", '[data-jarvis-brief-cursor="true"] [data-jarvis-work-on]'],
            ["jarvis:record-band", "[data-jarvis-band-toggle]"],
        ])("%s clicks %s, and passes the key when it is not drawn", (id, selector) => {
            const click = vi.fn();
            const querySelector = vi.fn(() => ({ click }));
            vi.stubGlobal("document", { querySelector });
            expect(find(id).run(jarvis)).toBeUndefined();
            expect(querySelector).toHaveBeenCalledWith(selector);
            expect(click).toHaveBeenCalledOnce();

            vi.stubGlobal("document", { querySelector: () => null });
            expect(find(id).run(jarvis)).toBe(false);
        });
    });

    it("the composer's Escape is live only on the Jarvis surface, inside a field, and hidden from the palette", () => {
        const b = find("jarvis:blur-composer");
        expect(b.paletteHidden).toBe(true);
        expect(b.when!({ ...jarvis, editable: true })).toBe(true);
        expect(b.when!({ ...jarvis, surface: "cockpit", editable: true })).toBe(false);
        expect(b.when!({ ...jarvis, editable: true, modalOpen: true })).toBe(false);
    });
});

describe("Agent keys, stepping and toggles", () => {
    const nav: KeyContext = { surface: "agent", editable: false, modalOpen: false, leader: null };
    const build = (focus = "b") => {
        const model = {
            orderAtom: atom(["a", "b", "c"]),
            focusIdAtom: atom<string | undefined>(focus),
            focusReplyAtom: atom(true),
            agentsAtom: atom([{ id: "a", state: "working" }]),
        } as any;
        return { model, find: (id: string) => buildAgentBindings(model).find((b) => b.id === id)! };
    };

    afterEach(() => {
        globalStore.set(railVisibleAtom, true);
        globalStore.set(terminalFullscreenAtom, false);
        globalStore.set(focusSubagentAtom, null);
        globalStore.set(shellTaskPeekAtom, null);
        globalStore.set(docReviewAtom, null);
    });

    it.each([
        ["agent:prev", "a"],
        ["agent:prev-k", "a"],
        ["agent:next", "c"],
        ["agent:next-j", "c"],
    ])("%s moves the focus to %s and drops any open reply box", (id, expected) => {
        const { model, find } = build();
        find(id).run(nav);
        expect(globalStore.get(model.focusIdAtom)).toBe(expected);
        expect(globalStore.get(model.focusReplyAtom)).toBe(false);
    });

    it("toggles the rail and fullscreen, and F11 toggles fullscreen too", () => {
        const { find } = build();
        const rail = globalStore.get(railVisibleAtom);
        find("agent:toggle-rail").run(nav);
        expect(globalStore.get(railVisibleAtom)).toBe(!rail);

        globalStore.set(terminalFullscreenAtom, false);
        find("agent:fullscreen").run(nav);
        expect(globalStore.get(terminalFullscreenAtom)).toBe(true);
        find("agent:fullscreen-chord").run(nav);
        expect(globalStore.get(terminalFullscreenAtom)).toBe(false);
        find("agent:fullscreen-chord").run(nav);
        expect(globalStore.get(terminalFullscreenAtom)).toBe(true);
    });

    it("keeps the review and F11 duplicates out of the palette", () => {
        const { find } = build();
        expect(find("agent:review").paletteHidden).toBe(true);
        expect(find("agent:fullscreen-chord").paletteHidden).toBe(true);
    });

    it("returning to the nav is live only on the Agent surface, while a field holds focus", () => {
        const b = build().find("agent:return-nav");
        expect(b.when!({ ...nav, editable: true })).toBe(true);
        expect(b.when!({ ...nav, editable: false })).toBe(false);
        expect(b.when!({ ...nav, surface: "cockpit", editable: true })).toBe(false);
    });

    it("lets the review key pass when the focused agent is not on the roster", () => {
        const { find } = build("gone");
        expect(find("agent:review").run(nav)).toBe(false);
        expect(globalStore.get(docReviewAtom)).toBeNull();
    });

    it.each([
        ["subagent:back", () => globalStore.set(focusSubagentAtom, { parentId: "p", agentId: "s" } as any)],
        ["shelltask:back", () => globalStore.set(shellTaskPeekAtom, { parentId: "p", taskId: "t" })],
    ])("%s is live on the Agent surface only, and not under a modal", (id, arrange) => {
        arrange();
        const b = build().find(id);
        expect(b.when!(nav)).toBe(true);
        expect(b.when!({ ...nav, surface: "cockpit" })).toBe(false);
        expect(b.when!({ ...nav, modalOpen: true })).toBe(false);
    });
});

describe("Diff keys, DOM and toggles", () => {
    const on = { surface: "files", editable: false, modalOpen: false, leader: null } as KeyContext;
    const find = (id: string) => buildFilesBindings().find((b) => b.id === id)!;
    const compare = {
        repo: { origin: { kind: "agent", id: "a1" }, label: "a1" },
        range: { kind: "compare", base: "main", head: "feat", form: "mergebase", from: { kind: "working" } },
    } as any;

    beforeEach(() => {
        globalStore.set(diffScopeAtom, null);
        globalStore.set(historyFiltersAtom, NO_FILTERS);
        globalStore.set(historyScrollAtom, 0);
        vi.mocked(gotoChange).mockClear();
    });
    afterEach(() => vi.unstubAllGlobals());

    const stubElement = (el: object | null) => {
        const querySelector = vi.fn(() => el);
        vi.stubGlobal("document", { querySelector });
        return querySelector;
    };

    it("focuses the history filter field when it is on screen", () => {
        const el = { focus: vi.fn() };
        const querySelector = stubElement(el);
        expect(find("files:filter").run(on)).toBeUndefined();
        expect(querySelector).toHaveBeenCalledWith("[data-history-filter]");
        expect(el.focus).toHaveBeenCalledOnce();
    });

    it("flips split view and whitespace handling on each press", () => {
        globalStore.set(splitViewAtom, false);
        globalStore.set(ignoreWsAtom, false);
        find("files:toggle-split").run(on);
        find("files:toggle-whitespace").run(on);
        expect(globalStore.get(splitViewAtom)).toBe(true);
        expect(globalStore.get(ignoreWsAtom)).toBe(true);
        find("files:toggle-split").run(on);
        find("files:toggle-whitespace").run(on);
        expect(globalStore.get(splitViewAtom)).toBe(false);
        expect(globalStore.get(ignoreWsAtom)).toBe(false);
    });

    it("asks the editor for the next and previous change", () => {
        find("files:next-change").run(on);
        expect(gotoChange).toHaveBeenLastCalledWith("next");
        find("files:prev-change").run(on);
        expect(gotoChange).toHaveBeenLastCalledWith("previous");
    });

    it("Escape clears the active history filters", () => {
        globalStore.set(historyFiltersAtom, { author: "dana", path: "", text: "" });
        find("files:clear-filters").run(on);
        expect(globalStore.get(historyFiltersAtom)).toEqual(NO_FILTERS);
    });

    it("g g still resets the history scroll when the scroll container is not on screen", () => {
        globalStore.set(historyScrollAtom, 800);
        stubElement(null);
        find("files:top").run(on);
        expect(globalStore.get(historyScrollAtom)).toBe(0);
    });

    it("c clicks the compare chip, and passes the key when none is drawn", () => {
        const click = vi.fn();
        const querySelector = stubElement({ click });
        expect(find("files:compare").run(on)).toBeUndefined();
        expect(querySelector).toHaveBeenCalledWith('[data-range-chip="compare"]');
        expect(click).toHaveBeenCalledOnce();
        stubElement(null);
        expect(find("files:compare").run(on)).toBe(false);
    });

    it("c inside compare clicks the ref pair", () => {
        globalStore.set(diffScopeAtom, compare);
        const click = vi.fn();
        const querySelector = stubElement({ click });
        expect(find("files:change-refs").run(on)).toBeUndefined();
        expect(querySelector).toHaveBeenCalledWith("[data-ref-pair]");
        expect(click).toHaveBeenCalledOnce();
    });

    it("Escape inside compare returns to the range compare was entered from", () => {
        globalStore.set(diffScopeAtom, compare);
        find("files:exit-compare").run(on);
        expect(globalStore.get(diffScopeAtom)).toEqual({ ...compare, range: { kind: "working" } });
    });
});

describe("Code keys, posture and the tree", () => {
    const code: KeyContext = { surface: "code", editable: false, modalOpen: false, leader: null };
    const find = (id: string) => buildCodeBindings(stubModel()).find((b) => b.id === id)!;

    afterEach(() => {
        vi.unstubAllGlobals();
        globalStore.set(codeTreeFocusedAtom, false);
        globalStore.set(codeIndexAtom, null);
        globalStore.set(codeCursorAtom, null);
        vi.mocked(startCreate).mockClear();
    });

    it.each(["code:back", "code:forward", "code:refresh", "code:diff"])(
        "%s is live on the Code surface out of a field and a modal",
        (id) => {
            const b = find(id);
            expect(b.when!(code)).toBe(true);
            expect(b.when!({ ...code, surface: "cockpit" })).toBe(false);
            expect(b.when!({ ...code, editable: true })).toBe(false);
            expect(b.when!({ ...code, modalOpen: true })).toBe(false);
        }
    );

    it("save is bound to the Code surface alone, whatever focus holds", () => {
        const b = find("code:save");
        expect(b.when!({ ...code, editable: true })).toBe(true);
        expect(b.when!({ ...ctx("cockpit"), editable: true })).toBe(false);
    });

    it.each(["code:search", "code:focus-tree", "code:focus-editor", "code:definition", "code:references", "code:symbols"])(
        "%s is live on the Code surface, from the editor too, but not under a modal",
        (id) => {
            const b = find(id);
            expect(b.when!(code)).toBe(true);
            expect(b.when!({ ...code, editable: true })).toBe(true);
            expect(b.when!({ ...code, surface: "cockpit" })).toBe(false);
            expect(b.when!({ ...code, modalOpen: true })).toBe(false);
        }
    );

    it("moves the tree cursor on j and lets the key pass at the last row", () => {
        globalStore.set(codeIndexAtom, { paths: ["a.ts", "b.ts"], isRepo: true, truncated: false });
        globalStore.set(codeCursorAtom, "a.ts");
        expect(find("code:tree-next").run(code)).toBeUndefined();
        expect(globalStore.get(codeCursorAtom)).toBe("b.ts");
        expect(find("code:tree-next").run(code)).toBe(false);
        expect(find("code:tree-prev").run(code)).toBeUndefined();
        expect(globalStore.get(codeCursorAtom)).toBe("a.ts");
        expect(find("code:tree-prev").run(code)).toBe(false);
    });

    it("n starts a new file and Shift+N a new folder", () => {
        find("code:new-file").run(code);
        expect(startCreate).toHaveBeenLastCalledWith(false);
        find("code:new-folder").run(code);
        expect(startCreate).toHaveBeenLastCalledWith(true);
        expect(startCreate).toHaveBeenCalledTimes(2);
    });

    // the tree is focused one frame after the sidebar opens, so a focus() before that lands on a hidden node
    it("waits a frame to focus the tree once the collapsed sidebar has been opened", () => {
        const treeFocus = vi.fn();
        const tree = { closest: () => null, focus: treeFocus };
        const opener = { classList: { contains: () => false }, click: vi.fn(), focus: vi.fn() };
        vi.stubGlobal("document", {
            querySelector: (selector: string) => (selector.includes("Expand Code sidebar") ? opener : tree),
        });
        const frames: (() => void)[] = [];
        vi.stubGlobal("window", { requestAnimationFrame: (cb: () => void) => frames.push(cb) });

        find("code:focus-tree").run(code);

        expect(treeFocus).not.toHaveBeenCalled();
        expect(frames).toHaveLength(1);
        frames[0]();
        expect(treeFocus).toHaveBeenCalledOnce();
    });

    it("F12 and Shift+F12 let the key pass with no word at the caret", () => {
        vi.mocked(caretWord).mockReturnValue(null);
        expect(find("code:definition").run(code)).toBe(false);
        expect(find("code:references").run(code)).toBe(false);
        expect(goToDefinition).not.toHaveBeenCalled();
        expect(findReferences).not.toHaveBeenCalled();
    });

    it("F12 looks up the caret word's definition, and Shift+F12 its references", () => {
        vi.mocked(caretWord).mockReturnValue({ word: "openPath", lang: "ts" });
        // the sidebar opener is looked up in the DOM; there is none here
        vi.stubGlobal("document", { querySelector: () => null });
        const model = stubModel();
        const def = buildCodeBindings(model).find((b) => b.id === "code:definition")!;
        expect(def.run(code)).toBeUndefined();
        expect(goToDefinition).toHaveBeenLastCalledWith(model, "openPath", "ts");
        expect(find("code:references").run(code)).toBeUndefined();
        expect(findReferences).toHaveBeenLastCalledWith("openPath");
        vi.mocked(caretWord).mockReturnValue(null);
    });

    it("Ctrl+Shift+O opens the search seeded with @", () => {
        const model = {
            ...stubModel(),
            paletteOpenAtom: atom(false),
            paletteSeedAtom: atom<string | null>(null) as PrimitiveAtom<string | null>,
        };
        buildCodeBindings(model as any)
            .find((b) => b.id === "code:symbols")!
            .run(code);
        expect(globalStore.get(model.paletteSeedAtom)).toBe("@");
        expect(globalStore.get(model.paletteOpenAtom)).toBe(true);
    });
});

describe("brainstorm check review keys", () => {
    const nav: KeyContext = { surface: "agent", editable: false, modalOpen: false, leader: null };
    const typing: KeyContext = { ...nav, editable: true };
    const REVIEW_KEYS = [
        "agent:brainstorm-review-next",
        "agent:brainstorm-review-prev",
        "agent:brainstorm-review-open",
        "agent:brainstorm-review-keep",
        "agent:brainstorm-review-restore",
    ];
    // one change waiting on keep or put back, one new guess, one decision left as it was
    const checked: BrainstormFile = {
        v: 1,
        title: "Forecast",
        spec: "docs/spec.md",
        question: null,
        working: null,
        parts: [
            {
                id: "grain",
                title: "Forecast grain",
                state: "guess",
                was: "Daily, for every field.",
                body: "Daily event_count.",
                why: "builder question 1",
            },
            { id: "torch", title: "The move to PyTorch", state: "guess", body: "A shared torch base." },
            { id: "intent", title: "Intent and why", state: "yours", body: "Why it exists." },
        ],
        history: [],
        done: true,
        check: {
            yours: [{ q: "What should the forecast act on?", a: "event_count", into: ["grain"] }],
            calls: [],
            answered: [],
            touched: ["grain"],
        },
        run: null,
    };
    let model: any;
    const all = () => [...buildGlobalBindings(model), ...buildListNavBindings(model), ...buildAgentBindings(model)];
    const find = (id: string) => all().find((b) => b.id === id)!;
    const active = (id: string, c: KeyContext = nav) => find(id).when!(c);
    const claiming = (key: string, c: KeyContext = nav) =>
        all()
            .filter((b) => b.keys === key && b.when?.(c) !== false)
            .map((b) => b.id);
    const withFile = (file: BrainstormFile) => updateBrainstorm("a1", (s) => ({ ...s, file }));

    beforeEach(() => {
        vi.mocked(sendBrainstorm).mockClear();
        vi.stubGlobal("document", { activeElement: null });
        model = {
            ...stubModel("a1"),
            surfaceAtom: atom<SurfaceKey>("agent"),
            agentsAtom: atom([{ id: "a1", name: "Agent", blockId: "b1" }]),
        };
        attachBrainstorm("a1", { topic: "forecast", cwd: "C:\\p" }, 0);
        withFile(checked);
        setBrainstormMode("a1", "brainstorm", 1);
    });

    afterEach(() => {
        detachBrainstorm("a1");
        globalStore.set(getProcExitAtom("b1"), undefined);
        vi.unstubAllGlobals();
    });

    it("an exited agent's card is not the review: j/k stay on the agents and nothing claims y or u", () => {
        globalStore.set(getProcExitAtom("b1"), { code: 0, at: 1 });
        for (const id of REVIEW_KEYS) {
            expect(active(id), id).toBe(false);
        }
        expect(active("agent:next-j")).toBe(true);
        expect(claiming("y")).toEqual([]);
        updateBrainstorm("a1", (s) => ({ ...s, showDesign: true, designOpen: true }));
        expect(active("agent:brainstorm-review-next")).toBe(true);
    });

    it("in the review, j k Enter y u are the review's and the agent j/k stand down; the arrows still move agents", () => {
        for (const id of REVIEW_KEYS) {
            expect(active(id), id).toBe(true);
        }
        expect(active("agent:next-j")).toBe(false);
        expect(active("agent:prev-k")).toBe(false);
        expect(active("agent:next")).toBe(true);
        expect(active("agent:prev")).toBe(true);
        for (const key of ["j", "k", "Enter", "y", "u"]) {
            expect(claiming(key), key).toHaveLength(1);
        }
    });

    it("typing in the answer box or an edit box types: no review key is live", () => {
        for (const id of REVIEW_KEYS) {
            expect(active(id, typing), id).toBe(false);
        }
    });

    it("the talk view and the terminal keep j/k on the agents, and nothing claims y or u", () => {
        withFile({ ...checked, check: null });
        for (const id of REVIEW_KEYS) {
            expect(active(id), id).toBe(false);
        }
        expect(active("agent:next-j")).toBe(true);
        expect(active("agent:prev-k")).toBe(true);
        expect(claiming("y")).toEqual([]);
        expect(claiming("u")).toEqual([]);
        withFile(checked);
        setBrainstormMode("a1", "terminal", 2);
        expect(active("agent:brainstorm-review-next")).toBe(false);
        expect(active("agent:next-j")).toBe(true);
    });

    it("a builder question in the main area is not the review; the review opened over it is", () => {
        withFile({
            ...checked,
            check: { ...checked.check!, yours: [...checked.check!.yours, { q: "A day with no row?" }] },
        });
        expect(active("agent:brainstorm-review-next")).toBe(false);
        expect(active("agent:next-j")).toBe(true);
        openBrainstormDesign("a1", true);
        expect(active("agent:brainstorm-review-next")).toBe(true);
        expect(active("agent:next-j")).toBe(false);
    });

    it("another focused agent keeps its j/k", () => {
        globalStore.set(model.focusIdAtom, "a2");
        expect(active("agent:brainstorm-review-next")).toBe(false);
        expect(active("agent:next-j")).toBe(true);
    });

    it("j and k move the cursor over the changed rows then the new ones, stopping at both ends", () => {
        find("agent:brainstorm-review-next").run(nav);
        expect(getBrainstorm("a1")!.review.cursor).toBe("grain");
        find("agent:brainstorm-review-next").run(nav);
        expect(getBrainstorm("a1")!.review.cursor).toBe("torch");
        find("agent:brainstorm-review-next").run(nav);
        expect(getBrainstorm("a1")!.review.cursor).toBe("torch");
        find("agent:brainstorm-review-prev").run(nav);
        expect(getBrainstorm("a1")!.review.cursor).toBe("grain");
    });

    it("y keeps a change and u puts mine back, each for the cursor row", () => {
        setReviewCursor("a1", "grain");
        find("agent:brainstorm-review-keep").run(nav);
        find("agent:brainstorm-review-restore").run(nav);
        expect(vi.mocked(sendBrainstorm).mock.calls.map((c) => c[1])).toEqual([
            { kind: "keep", part: "grain" },
            { kind: "restore", part: "grain" },
        ]);
        expect(vi.mocked(sendBrainstorm).mock.calls[0][0]).toMatchObject({ id: "a1", blockId: "b1" });
    });

    it("on a guess y confirms it and u passes the key on, sending nothing", () => {
        setReviewCursor("a1", "torch");
        find("agent:brainstorm-review-keep").run(nav);
        expect(vi.mocked(sendBrainstorm).mock.calls.map((c) => c[1])).toEqual([{ kind: "confirm", part: "torch" }]);
        expect(find("agent:brainstorm-review-restore").run(nav)).toBe(false);
        expect(sendBrainstorm).toHaveBeenCalledTimes(1);
    });

    it("while the agent writes y and u pass the key on, as the row's buttons are locked", () => {
        setReviewCursor("a1", "grain");
        withFile({ ...checked, working: "Rewriting the forecast grain" });
        expect(find("agent:brainstorm-review-keep").run(nav)).toBe(false);
        expect(find("agent:brainstorm-review-restore").run(nav)).toBe(false);
        expect(sendBrainstorm).not.toHaveBeenCalled();
    });

    it("with no cursor row y, u and Enter pass the key on", () => {
        expect(find("agent:brainstorm-review-keep").run(nav)).toBe(false);
        expect(find("agent:brainstorm-review-restore").run(nav)).toBe(false);
        expect(find("agent:brainstorm-review-open").run(nav)).toBe(false);
        expect(sendBrainstorm).not.toHaveBeenCalled();
    });

    it("Enter opens and closes the cursor row, and leaves a focused button its own press", () => {
        setReviewCursor("a1", "grain");
        find("agent:brainstorm-review-open").run(nav);
        expect(getBrainstorm("a1")!.review.open).toEqual({ grain: true });
        find("agent:brainstorm-review-open").run(nav);
        expect(getBrainstorm("a1")!.review.open).toEqual({ grain: false });
        vi.stubGlobal("document", { activeElement: { tagName: "BUTTON" } });
        expect(find("agent:brainstorm-review-open").run(nav)).toBe(false);
        expect(getBrainstorm("a1")!.review.open).toEqual({ grain: false });
    });
});
