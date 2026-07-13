// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockNodeModel } from "@/app/block/blocktypes";
import type { TabModel } from "@/app/store/tab-model";
import { AgentsViewModel } from "@/app/view/agents/agents";
import { AiFileDiffViewModel } from "@/app/view/aifilediff/aifilediff";
import { VDomModel } from "@/app/view/vdom/vdom-model";
import { WaveEnv } from "@/app/waveenv/waveenv";
import { atom } from "jotai";
import { blockViewToIcon, blockViewToName } from "./blockutil";
import { TermViewModel } from "@/view/term/term-model";

const BlockRegistry: Map<string, ViewModelClass> = new Map();
BlockRegistry.set("term", TermViewModel);
BlockRegistry.set("vdom", VDomModel);
BlockRegistry.set("aifilediff", AiFileDiffViewModel);
BlockRegistry.set("agents", AgentsViewModel);

function makeDefaultViewModel(viewType: string): ViewModel {
    const viewModel: ViewModel = {
        viewType: viewType,
        viewIcon: atom(blockViewToIcon(viewType)),
        viewName: atom(blockViewToName(viewType)),
        preIconButton: atom(null),
        endIconButtons: atom(null),
        viewComponent: null,
    };
    return viewModel;
}

function makeViewModel(
    blockId: string,
    blockView: string,
    nodeModel: BlockNodeModel,
    tabModel: TabModel,
    waveEnv: WaveEnv
): ViewModel {
    const ctor = BlockRegistry.get(blockView);
    if (ctor != null) {
        return new ctor({ blockId, nodeModel, tabModel, waveEnv });
    }
    return makeDefaultViewModel(blockView);
}

export { makeViewModel };
