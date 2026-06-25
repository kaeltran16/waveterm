// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { getTabModelByTabId } from "@/app/store/tab-model";
import { AgentsViewModel } from "@/app/view/agents/agents";
import { CockpitShell } from "@/app/view/agents/cockpitshell";
import { WaveEnv, WaveEnvContext } from "@/app/waveenv/waveenv";
import { makeWaveEnvImpl } from "@/app/waveenv/waveenvimpl";
import { fireAndForget } from "@/util/util";
import { Provider } from "jotai";
import { useRef } from "react";
import { newAgentSession } from "./cockpit-actions";
import "./cockpit.scss";
import { makeSyntheticNodeModel } from "./synthetic-node-model";
import { CockpitTitlebar } from "./titlebar";

const AgentsBlockId = "cockpit-agents";

export function CockpitRoot() {
    const waveEnvRef = useRef(makeWaveEnvImpl());
    return (
        <Provider store={globalStore}>
            <WaveEnvContext.Provider value={waveEnvRef.current}>
                <div className="cockpit-shell">
                    <CockpitTitlebar />
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
        agentsModelRef.current = model;
    }
    const model = agentsModelRef.current;
    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="shrink-0 border-b border-border p-2">
                <button
                    onClick={() => fireAndForget(() => newAgentSession(model))}
                    className="cursor-pointer rounded-[6px] bg-accent px-3 py-1.5 text-[13px] font-semibold text-white hover:opacity-90"
                >
                    + New Agent
                </button>
            </div>
            <div className="min-h-0 flex-1">
                <CockpitShell model={model} tabId={tabIdRef.current} />
            </div>
        </div>
    );
}
