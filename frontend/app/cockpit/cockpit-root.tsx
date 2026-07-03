// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
import { ModalsRenderer } from "@/app/modals/modalsrenderer";
import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { buildGlobalBindings } from "@/app/store/keybindings/bindings";
import { initKeybindingDispatcher } from "@/app/store/keybindings/dispatcher";
import { useKeybindings } from "@/app/store/keybindings/store";
import { getTabModelByTabId } from "@/app/store/tab-model";
import { AgentsViewModel } from "@/app/view/agents/agents";
import { startupSurfaceAtom } from "@/app/view/agents/cockpitprefsstore";
import { useApplyCockpitTheme } from "@/app/view/agents/themestore";
import { CockpitShell } from "@/app/view/agents/cockpitshell";
import { NewAgentModal } from "@/app/view/agents/newagentmodal";
import { NewProjectModal } from "@/app/view/agents/newprojectmodal";
import { WaveEnv, WaveEnvContext } from "@/app/waveenv/waveenv";
import { makeWaveEnvImpl } from "@/app/waveenv/waveenvimpl";
import { Provider } from "jotai";
import { useEffect, useMemo, useRef } from "react";
import { CockpitAppBar } from "./app-bar";
import { CommandPalette } from "./command-palette";
import "./cockpit.scss";
import { ShortcutsCheatSheet } from "./shortcuts-cheatsheet";
import { makeSyntheticNodeModel } from "./synthetic-node-model";
import { WhichKeyBar } from "./whichkey-bar";

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
    useApplyCockpitTheme();
    useEffect(() => initKeybindingDispatcher(model), [model]);
    const globalBindings = useMemo(() => buildGlobalBindings(model), [model]);
    useKeybindings(globalBindings);
    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <CockpitAppBar model={model} />
            <div className="min-h-0 flex-1">
                <CockpitShell model={model} tabId={tabIdRef.current} />
            </div>
            <NewProjectModal model={model} />
            <NewAgentModal model={model} />
            <CommandPalette model={model} />
            <WhichKeyBar />
            <ShortcutsCheatSheet model={model} />
            <ModalsRenderer />
        </div>
    );
}
