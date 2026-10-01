// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// DEV-ONLY seam for the resource-linking CDP scenario, installed by BriefSurface and never imported in a
// production build. __openAddress drives the one router with an address and its hint, including the case no
// rendered link can reach: an address the parser rejects.

import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import type { AddressHint } from "./address";
import { briefSheetOpenAtom } from "./jarvisstore";
import { activeSubjectAtom } from "./jarvissubjectstore";
import { openAddress, peekAddress } from "./openref";
import { peekItemAtom, startPeek, type PeekTarget } from "./peekstore";

// __peekProbe reads what a peek must leave alone (the host's selection) and the peek's own item, for the
// peek-ctrl-click scenario. __peekAddress peeks each kind for peek-item-views, and __peekLoading holds a peek in
// its loading frame, which a real load leaves too quickly to photograph.
export function installLinkingDevHooks(model: AgentsViewModel): void {
    const w = window as unknown as {
        __openAddress?: (address: string, hint?: AddressHint) => Promise<unknown>;
        __peekAddress?: (address: string, hint?: AddressHint) => Promise<unknown>;
        __peekLoading?: (target: PeekTarget) => void;
        __peekProbe?: () => unknown;
    };
    w.__openAddress = (address, hint) => openAddress(model, address, hint ?? undefined);
    w.__peekAddress = (address, hint) => peekAddress(model, address, hint ?? undefined);
    w.__peekLoading = (target) => {
        startPeek(target);
    };
    w.__peekProbe = () => ({
        surface: globalStore.get(model.surfaceAtom),
        subject: globalStore.get(activeSubjectAtom),
        sheetOpen: globalStore.get(briefSheetOpenAtom),
        peekItem: globalStore.get(peekItemAtom),
    });
}
