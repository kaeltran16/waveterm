// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
import { globalStore } from "@/app/store/jotaiStore";
import { ObjectService } from "@/app/store/services";
import { AgentsViewModel } from "@/app/view/agents/agents";

// Launch a new agent from the cockpit: create a claude terminal block in the active tab and focus it.
// The controller starts when the focus pane renders the block (the backend defers the controller until
// render). CreateBlock's response updates apply to this client's WOS cache, so the focus pane picks the
// block up without a reload (the web service layer returns updates to the caller; it does not broadcast).
export async function newAgentSession(model: AgentsViewModel): Promise<void> {
    const blockId = await ObjectService.CreateBlock(
        { meta: { view: "term", controller: "cmd", cmd: "claude", "cmd:shell": true } },
        { termsize: { rows: 40, cols: 120 } }
    );
    globalStore.set(model.terminalTargetAtom, blockId);
}
