// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Renders the focused agent's terminal block in-place — the cockpit's replacement for
// setActiveTab(agent.id). The term view registers its own wshrpc route in its ctor (works because
// bootWaveCore connected the global client) and unregisters it in dispose(), so we recreate the
// model on blockId change and dispose the previous one to avoid leaking FE block routes.
import { makeViewModel } from "@/app/block/blockregistry";
import { getTabModelByTabId, TabModelContext } from "@/app/store/tab-model";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { useEffect, useMemo, useRef } from "react";
import { makeSyntheticNodeModel } from "./synthetic-node-model";

export function CockpitFocusPane({ blockId, tabId }: { blockId: string; tabId: string }) {
    const waveEnv = useWaveEnv();
    const blockRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    // the term view reads useTabModel() — provide the block's own tab model (matches app.tsx)
    const tabModel = useMemo(() => getTabModelByTabId(tabId, waveEnv), [tabId, waveEnv]);
    const model = useMemo(
        () => makeViewModel(blockId, "term", makeSyntheticNodeModel(blockId), tabModel, waveEnv),
        [blockId, tabModel, waveEnv]
    );
    useEffect(() => () => model.dispose?.(), [model]);
    const VC = model.viewComponent;
    return (
        <TabModelContext.Provider value={tabModel}>
            <div className="cockpit-focus-pane" ref={contentRef}>
                <VC blockId={blockId} blockRef={blockRef} contentRef={contentRef} model={model} />
            </div>
        </TabModelContext.Provider>
    );
}
