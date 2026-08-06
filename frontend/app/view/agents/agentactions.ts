// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import { WorkspaceService } from "@/app/store/services";
import { fireAndForget } from "@/util/util";
import type { AgentVM } from "./agentsviewmodel";

// Close a whole session (its id is the tabId). Shows the same confirm modal as the header Close
// button, then CloseTab -> wcore.DeleteTab tears down the block and reassigns the active tab.
// Takes the VM rather than loose id/name strings so the prompt can never name one session while
// closing another — and so a plain terminal, which has no agent to stop, gets its own wording.
export function confirmCloseSession(vm: Pick<AgentVM, "id" | "name" | "kind">) {
    const ws = globalStore.get(atoms.workspace);
    if (ws?.oid == null) {
        return;
    }
    const isTerminal = vm.kind === "terminal";
    const label = isTerminal ? "Close terminal" : "Close agent";
    modalsModel.pushModal("ConfirmModal", {
        title: label,
        message: isTerminal
            ? `Close the terminal "${vm.name}"? This ends its shell and can't be undone.`
            : `End the session for "${vm.name}"? This stops the agent and can't be undone.`,
        confirmLabel: label,
        destructive: true,
        onConfirm: () => fireAndForget(() => WorkspaceService.CloseTab(ws.oid, vm.id, false)),
    });
}
