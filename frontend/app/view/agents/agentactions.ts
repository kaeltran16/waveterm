// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import { WorkspaceService } from "@/app/store/services";
import { fireAndForget } from "@/util/util";

// Close a whole agent session (agentId is the tabId). Shows the same confirm modal as the header
// Close button, then CloseTab -> wcore.DeleteTab tears down the block and reassigns the active tab.
export function confirmCloseAgent(agentId: string, agentName: string) {
    const ws = globalStore.get(atoms.workspace);
    if (ws?.oid == null) {
        return;
    }
    modalsModel.pushModal("ConfirmModal", {
        title: "Close terminal",
        message: `End the session for "${agentName}"? This stops the agent and can't be undone.`,
        confirmLabel: "Close terminal",
        destructive: true,
        onConfirm: () => fireAndForget(() => WorkspaceService.CloseTab(ws.oid, agentId, false)),
    });
}
