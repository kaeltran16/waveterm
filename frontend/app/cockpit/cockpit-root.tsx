// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
import { ModalsRenderer } from "@/app/modals/modalsrenderer";
import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { getTabModelByTabId } from "@/app/store/tab-model";
import { confirmCloseAgent } from "@/app/view/agents/agentactions";
import { AgentsViewModel, SURFACE_ORDER } from "@/app/view/agents/agents";
import { startupSurfaceAtom } from "@/app/view/agents/cockpitprefsstore";
import { CockpitShell } from "@/app/view/agents/cockpitshell";
import { NewAgentModal } from "@/app/view/agents/newagentmodal";
import { NewProjectModal } from "@/app/view/agents/newprojectmodal";
import { WaveEnv, WaveEnvContext } from "@/app/waveenv/waveenv";
import { makeWaveEnvImpl } from "@/app/waveenv/waveenvimpl";
import { Provider } from "jotai";
import { useEffect, useRef } from "react";
import { CockpitAppBar } from "./app-bar";
import { CommandPalette } from "./command-palette";
import "./cockpit.scss";
import { makeSyntheticNodeModel } from "./synthetic-node-model";

const AgentsBlockId = "cockpit-agents";

export function CockpitRoot() {
    const waveEnvRef = useRef(makeWaveEnvImpl());
    return (
        <Provider store={globalStore}>
            <WaveEnvContext.Provider value={waveEnvRef.current}>
                <div className="cockpit-shell">
                    <CockpitBody waveEnv={waveEnvRef.current} />
                </div>
            </WaveEnvContext.Provider>
        </Provider>
    );
}

// Inside the Provider so useAtomValue resolves to globalStore (the boot store), not jotai's default.
function CockpitBody({ waveEnv }: { waveEnv: WaveEnv }) {
    const agentsModelRef = useRef<AgentsViewModel>(null);
    const tabIdRef = useRef<string>(null);
    const lastCtrlCRef = useRef<number | null>(null);
    if (agentsModelRef.current == null) {
        tabIdRef.current = globalStore.get(atoms.staticTabId);
        const model = new AgentsViewModel({
            blockId: AgentsBlockId,
            nodeModel: makeSyntheticNodeModel(AgentsBlockId),
            tabModel: getTabModelByTabId(tabIdRef.current, waveEnv),
            waveEnv,
        });
        // Open the user's chosen startup surface (defaults to "cockpit", matching prior behavior).
        globalStore.set(model.surfaceAtom, globalStore.get(startupSurfaceAtom));
        agentsModelRef.current = model;
    }
    const model = agentsModelRef.current;
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && (e.key === "n" || e.key === "N")) {
                e.preventDefault();
                globalStore.set(model.newAgentOpenAtom, true);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [model]);
    useEffect(() => {
        const DOUBLE_CTRL_C_MS = 500;
        const onKeyCapture = (e: KeyboardEvent) => {
            if (!e.ctrlKey || e.altKey || e.metaKey) {
                return;
            }
            // Ctrl+1..8 -> jump directly to a surface (works on any surface, even in the terminal)
            if (!e.shiftKey && /^[1-8]$/.test(e.key)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                globalStore.set(model.surfaceAtom, SURFACE_ORDER[parseInt(e.key, 10) - 1]);
                return;
            }
            // Ctrl+P -> toggle the command palette. Global (preempts the terminal's readline
            // Ctrl+P history-back) — intentional, matches the Ctrl+1..8 capture behavior above.
            if ((e.key === "p" || e.key === "P") && !e.shiftKey) {
                e.preventDefault();
                e.stopImmediatePropagation();
                globalStore.set(model.paletteOpenAtom, (v) => !v);
                return;
            }
            const surface = globalStore.get(model.surfaceAtom);
            // Ctrl+Tab / Ctrl+Shift+Tab -> cycle agents (Agent surface only)
            if (e.key === "Tab" && surface === "agent") {
                e.preventDefault();
                e.stopImmediatePropagation();
                model.cycleFocus(e.shiftKey);
                return;
            }
            // Double Ctrl+C inside the focused terminal -> close the agent. Single Ctrl+C is left
            // untouched (not stopped) so it still reaches the PTY and interrupts the TUI.
            if ((e.key === "c" || e.key === "C") && !e.shiftKey && surface === "agent") {
                const inTerm =
                    (document.activeElement as HTMLElement | null)?.closest?.(".cockpit-focus-pane") != null;
                if (!inTerm) {
                    return;
                }
                const now = Date.now();
                if (lastCtrlCRef.current != null && now - lastCtrlCRef.current < DOUBLE_CTRL_C_MS) {
                    lastCtrlCRef.current = null;
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    const agents = globalStore.get(model.agentsAtom);
                    const fid = globalStore.get(model.focusIdAtom);
                    const a = agents.find((x) => x.id === fid) ?? agents[0];
                    if (a) {
                        confirmCloseAgent(a.id, a.name);
                    }
                } else {
                    lastCtrlCRef.current = now; // first press: fall through so the PTY receives ^C
                }
            }
        };
        window.addEventListener("keydown", onKeyCapture, true);
        return () => window.removeEventListener("keydown", onKeyCapture, true);
    }, [model]);
    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <CockpitAppBar model={model} />
            <div className="min-h-0 flex-1">
                <CockpitShell model={model} tabId={tabIdRef.current} />
            </div>
            <NewProjectModal model={model} />
            <NewAgentModal model={model} />
            <CommandPalette model={model} />
            <ModalsRenderer />
        </div>
    );
}
