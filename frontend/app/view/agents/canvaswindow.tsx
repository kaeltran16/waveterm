// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The canvas window: the Rendered view's modal over an agent's whole canvas, live like the Terminal view's canvas
// center (it is that CanvasPane, as the window). Mounted once on the Agent surface and driven by canvasWindowAtom.

import { ModalShell } from "@/app/modals/modalshell";
import { globalStore } from "@/app/store/jotaiStore";
import { buildCanvasWindowBindings } from "@/app/store/keybindings/bindings";
import { useKeybindings } from "@/app/store/keybindings/store";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { AgentsViewModel } from "./agents";
import { useBrainstormBoards } from "./brainstormpane";
import { CanvasPane } from "./canvaspane";
import {
    canvasStateAtom,
    canvasWindowAtom,
    canvasWindowScopeAtom,
    closeCanvasWindow,
    getCanvas,
    setMark,
} from "./canvasstore";
import { canvasEscape } from "./canvaswindowmodel";

// the window's one Esc handler: the Escape binding calls it, and so does ModalShell's onClose (Esc the binding's gates
// let through, and a backdrop press), so no single press both drops a mark and closes the window
export function escapeCanvasWindow(): void {
    const id = globalStore.get(canvasWindowAtom);
    const s = id != null ? getCanvas(id) : null;
    if (s != null && canvasEscape(s) === "drop-mark") {
        setMark(id!, null);
    } else {
        closeCanvasWindow();
    }
}

// built once: the bindings read the window's atom when a key arrives
const WINDOW_BINDINGS = buildCanvasWindowBindings(escapeCanvasWindow);

export function CanvasWindow({ model }: { model: AgentsViewModel }) {
    const id = useAtomValue(canvasWindowAtom);
    const scope = useAtomValue(canvasWindowScopeAtom);
    const surface = useAtomValue(model.surfaceAtom);
    const agents = useAtomValue(model.agentsAtom);
    const canvas = useAtomValue(canvasStateAtom(id ?? ""));
    const hasCanvas = canvas != null;
    const agent = id != null ? agents.find((a) => a.id === id) : undefined;
    const band = useBrainstormBoards(agent, canvas?.topic);
    useKeybindings(WINDOW_BINDINGS);
    // the atom is what mutes the surface's keys, so a window left with nothing to draw (its agent closed) closes
    useEffect(() => {
        if (id != null && (agent == null || !hasCanvas)) {
            closeCanvasWindow();
        }
    }, [id, agent, hasCanvas]);
    const open = agent != null && hasCanvas && surface === "agent";
    // portaled like the image viewer: a transformed ancestor would become the fixed backdrop's containing block. Out
    // of the surface's tree it no longer hides with the surface, so it draws only while the Agent surface shows
    return createPortal(
        <ModalShell open={open} onClose={escapeCanvasWindow} align="center" className="flex size-full flex-col">
            {open ? (
                <div data-canvas-window className="flex min-h-0 flex-1 flex-col">
                    <CanvasPane
                        model={model}
                        agent={agent}
                        scope={scope ?? undefined}
                        band={band ?? undefined}
                        onClose={closeCanvasWindow}
                    />
                </div>
            ) : null}
        </ModalShell>,
        document.body
    );
}
