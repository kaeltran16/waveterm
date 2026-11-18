// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { atom } from "jotai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { paneShown, showPane } from "./agentpanes";
import type { AgentsViewModel, SurfaceKey } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { attachBrainstorm, detachBrainstorm, getBrainstorm, setBrainstormMode } from "./brainstormstore";
import { isUnseen } from "./canvasmodel";
import { attachCanvas, detachCanvas, getCanvas, setCanvasMode, updateCanvas } from "./canvasstore";
import { pickerFlipAtom, viewModeAtom } from "./renderedmode";
import { focusSubagentAtom } from "./subagentsstore";
import { activateWorkspaceTab, openWorkspaceTab, setWorkspaceCollapsed, workspaceAtom } from "./workspacestore";

let seq = 0;
// the per-agent atoms live for the module's lifetime, so every test gets a fresh agent
let id = "";

const claude = (agentId: string): AgentVM => ({
    id: agentId,
    name: agentId,
    task: "",
    state: "idle",
    agent: "claude",
    blockId: `block-${agentId}`,
});

function fakeModel(agents: AgentVM[]): AgentsViewModel {
    return { agentsAtom: atom(agents), surfaceAtom: atom<SurfaceKey>("agent") } as unknown as AgentsViewModel;
}

let model: AgentsViewModel;

function view(mode: "rendered" | "terminal") {
    globalStore.set(viewModeAtom(id), mode);
    globalStore.set(pickerFlipAtom(id), null);
}

const brainstorm = () => attachBrainstorm(id, { topic: "lag", cwd: "/p" }, 0);
const canvas = () => attachCanvas(id, { topic: "t", dir: "/p/.superpowers/design/t", projectDir: "/p" }, 0);

beforeEach(() => {
    id = `ap-${++seq}`;
    model = fakeModel([claude(id)]);
    globalStore.set(focusSubagentAtom, null);
});

afterEach(() => {
    detachBrainstorm(id);
    detachCanvas(id);
});

describe("paneShown in Rendered", () => {
    beforeEach(() => view("rendered"));

    it("is the brainstorm while its tab is the active tab of an open pane", () => {
        brainstorm();
        openWorkspaceTab(id, { kind: "brainstorm" });
        expect(paneShown(model, id)).toBe("brainstorm");
    });

    it("is nothing while its tab is open but another is active", () => {
        brainstorm();
        openWorkspaceTab(id, { kind: "brainstorm" });
        openWorkspaceTab(id, { kind: "changes", selected: null });
        expect(paneShown(model, id)).toBeNull();
        activateWorkspaceTab(id, "brainstorm");
        expect(paneShown(model, id)).toBe("brainstorm");
    });

    it("is nothing while the pane is collapsed to its strip", () => {
        canvas();
        openWorkspaceTab(id, { kind: "canvas" });
        expect(paneShown(model, id)).toBe("canvas");
        setWorkspaceCollapsed(id, true);
        expect(paneShown(model, id)).toBeNull();
    });

    it("ignores the Terminal view's mode", () => {
        brainstorm();
        setBrainstormMode(id, "brainstorm", 1);
        expect(paneShown(model, id)).toBeNull();
    });

    it("never shows the canvas of an agent with a brainstorm", () => {
        brainstorm();
        canvas();
        openWorkspaceTab(id, { kind: "canvas" });
        expect(paneShown(model, id)).toBeNull();
        openWorkspaceTab(id, { kind: "brainstorm" });
        expect(paneShown(model, id)).toBe("brainstorm");
    });
});

describe("paneShown in Terminal", () => {
    beforeEach(() => view("terminal"));

    it("follows the brainstorm's and the canvas's mode", () => {
        brainstorm();
        expect(paneShown(model, id)).toBeNull();
        setBrainstormMode(id, "brainstorm", 1);
        expect(paneShown(model, id)).toBe("brainstorm");
        detachBrainstorm(id);
        canvas();
        setCanvasMode(id, "canvas", 1);
        expect(paneShown(model, id)).toBe("canvas");
        setCanvasMode(id, "terminal", 2);
        expect(paneShown(model, id)).toBeNull();
    });

    it("ignores an active tab, which only Rendered draws", () => {
        brainstorm();
        openWorkspaceTab(id, { kind: "brainstorm" });
        expect(paneShown(model, id)).toBeNull();
    });

    it("never shows the canvas of an agent with a brainstorm", () => {
        brainstorm();
        canvas();
        setCanvasMode(id, "canvas", 1);
        expect(paneShown(model, id)).toBeNull();
        setBrainstormMode(id, "brainstorm", 1);
        expect(paneShown(model, id)).toBe("brainstorm");
    });

    it("reads mode for an agent Rendered cannot draw, whatever its view", () => {
        view("rendered");
        model = fakeModel([{ ...claude(id), agent: "pi" }]);
        brainstorm();
        setBrainstormMode(id, "brainstorm", 1);
        expect(paneShown(model, id)).toBe("brainstorm");
    });
});

describe("showPane", () => {
    it("in Rendered opens and activates the tab, stamping the look, and leaves mode alone", () => {
        view("rendered");
        brainstorm();
        openWorkspaceTab(id, { kind: "changes", selected: null });
        setWorkspaceCollapsed(id, true);
        showPane(model, id, "brainstorm", true, 500);
        const ws = globalStore.get(workspaceAtom(id));
        expect(ws.tabs.map((t) => t.kind)).toEqual(["changes", "brainstorm"]);
        expect(ws.active).toBe("brainstorm");
        expect(ws.collapsed).toBe(false);
        expect(getBrainstorm(id)!.lastViewedMs).toBe(500);
        expect(getBrainstorm(id)!.mode).toBe("terminal");
        expect(paneShown(model, id)).toBe("brainstorm");
    });

    it("in Rendered closes the tab", () => {
        view("rendered");
        canvas();
        showPane(model, id, "canvas", true, 1);
        showPane(model, id, "canvas", false, 2);
        expect(globalStore.get(workspaceAtom(id)).tabs).toEqual([]);
        expect(paneShown(model, id)).toBeNull();
    });

    it("in Rendered stamps the canvas's look, so it no longer reads as unseen", () => {
        view("rendered");
        canvas();
        updateCanvas(id, (s) => ({ ...s, lastModifiedMs: 300, lastViewedMs: 100 }));
        showPane(model, id, "canvas", true, 400);
        expect(getCanvas(id)!.lastViewedMs).toBe(400);
        expect(getCanvas(id)!.mode).toBe("terminal");
    });

    it("in Terminal sets mode and opens no tab", () => {
        view("terminal");
        brainstorm();
        showPane(model, id, "brainstorm", true, 700);
        expect(getBrainstorm(id)!.mode).toBe("brainstorm");
        expect(getBrainstorm(id)!.lastViewedMs).toBe(700);
        expect(globalStore.get(workspaceAtom(id)).tabs).toEqual([]);
        showPane(model, id, "brainstorm", false, 800);
        expect(getBrainstorm(id)!.mode).toBe("terminal");
    });

    it("in Terminal hiding the canvas drops its mark", () => {
        view("terminal");
        canvas();
        showPane(model, id, "canvas", true, 1);
        updateCanvas(id, (s) => ({ ...s, marking: true, mark: { x: 1, y: 1, w: 2, h: 2, note: "" } }));
        showPane(model, id, "canvas", false, 2);
        expect(getCanvas(id)!.mode).toBe("terminal");
        expect(getCanvas(id)!.marking).toBe(false);
        expect(getCanvas(id)!.mark).toBeNull();
    });
});

describe("isUnseen", () => {
    it("is false while the canvas shows, in either view", () => {
        canvas();
        updateCanvas(id, (s) => ({ ...s, lastModifiedMs: 900, lastViewedMs: 100 }));
        view("rendered");
        openWorkspaceTab(id, { kind: "canvas" });
        expect(isUnseen(getCanvas(id)!, paneShown(model, id) === "canvas")).toBe(false);
        setWorkspaceCollapsed(id, true);
        expect(isUnseen(getCanvas(id)!, paneShown(model, id) === "canvas")).toBe(true);
        view("terminal");
        setCanvasMode(id, "canvas", 50);
        expect(isUnseen(getCanvas(id)!, paneShown(model, id) === "canvas")).toBe(false);
    });
});
