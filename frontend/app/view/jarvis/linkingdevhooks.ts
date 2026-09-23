// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// DEV-ONLY seam for the resource-linking CDP scenario, installed by BriefSurface and never imported in a
// production build. __openAddress drives the one router with an address and its hint, including the case no
// rendered link can reach: an address the parser rejects.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import type { AddressHint } from "./address";
import { openAddress } from "./openref";

export function installLinkingDevHooks(model: AgentsViewModel): void {
    const w = window as unknown as { __openAddress?: (address: string, hint?: AddressHint) => Promise<unknown> };
    w.__openAddress = (address, hint) => openAddress(model, address, hint ?? undefined);
}
