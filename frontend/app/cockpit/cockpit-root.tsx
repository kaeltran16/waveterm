// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { getTabModelByTabId } from "@/app/store/tab-model";
import * as WOS from "@/app/store/wos";
import { AgentsViewModel } from "@/app/view/agents/agents";
import { WaveEnv, WaveEnvContext } from "@/app/waveenv/waveenv";
import { makeWaveEnvImpl } from "@/app/waveenv/waveenvimpl";
import { fireAndForget } from "@/util/util";
import { atom, Provider, useAtomValue } from "jotai";
import { useRef } from "react";
import { newAgentSession } from "./cockpit-actions";
import "./cockpit.scss";
import { CockpitFocusPane } from "./focus-pane";
import { makeSyntheticNodeModel } from "./synthetic-node-model";
import { CockpitTitlebar } from "./titlebar";

const AgentsBlockId = "cockpit-agents";

// The active tab's primary session terminal (first term block with cmd:cwd — the same rule the
// session sidebar groups on). Rendered when no roster agent is focused, so a just-created session
// surfaces and its controller starts (the backend defers the controller until the block renders).
const activeTabTermBlockAtom = atom((get) => {
    const ws = get(atoms.workspace);
    const activeId = ws?.activetabid;
    if (!activeId) {
        return undefined;
    }
    const tab = get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", activeId)));
    for (const blockId of tab?.blockids ?? []) {
        const block = get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
        if (block?.meta?.view === "term" && block.meta["cmd:cwd"]) {
            return blockId;
        }
    }
    return undefined;
});

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
    const agentsBlockRef = useRef<HTMLDivElement>(null);
    const agentsContentRef = useRef<HTMLDivElement>(null);
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
        model.inlineTerminal = true;
        agentsModelRef.current = model;
    }
    const model = agentsModelRef.current;
    const AgentsVC = model.viewComponent;
    const agents = useAtomValue(model.agentsAtom);
    const targetBlockId = useAtomValue(model.terminalTargetAtom);
    const activeTermBlockId = useAtomValue(activeTabTermBlockAtom);
    const focusBlockId = targetBlockId ?? agents[0]?.blockId ?? activeTermBlockId;
    return (
        <div className="cockpit-main">
            <div className="cockpit-roster">
                <div className="cockpit-roster-toolbar">
                    <button className="cockpit-new-agent" onClick={() => fireAndForget(() => newAgentSession(model))}>
                        + New Agent
                    </button>
                </div>
                <div className="cockpit-roster-list" ref={agentsContentRef}>
                    <AgentsVC blockId={AgentsBlockId} blockRef={agentsBlockRef} contentRef={agentsContentRef} model={model} />
                </div>
            </div>
            {focusBlockId ? <CockpitFocusPane blockId={focusBlockId} tabId={tabIdRef.current} /> : null}
        </div>
    );
}
