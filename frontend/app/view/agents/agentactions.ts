// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import { WorkspaceService } from "@/app/store/services";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget, stringToBase64 } from "@/util/util";
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

// Close every tab a run still holds. A run whose lead was closed stays in the roster for as long as any of its
// task tabs does, and those hide under its folds, so the run row is the one place to clear them from.
export function confirmCloseRun(title: string, tabIds: string[]) {
    const ws = globalStore.get(atoms.workspace);
    if (ws?.oid == null || tabIds.length === 0) {
        return;
    }
    const sessions = tabIds.length === 1 ? "its 1 open session" : `its ${tabIds.length} open sessions`;
    modalsModel.pushModal("ConfirmModal", {
        title: "Close run",
        message: `Close "${title}" and ${sessions}? This stops those agents and can't be undone.`,
        confirmLabel: "Close run",
        destructive: true,
        onConfirm: () =>
            fireAndForget(async () => {
                for (const id of tabIds) {
                    await WorkspaceService.CloseTab(ws.oid, id, false);
                }
            }),
    });
}

// NUDGE_INPUT is what the rail's Resume types: a quiet agent picks it up as a new turn
export const NUDGE_INPUT = "continue\r";

// driveAgent types into an agent's terminal; a card without a terminal block has nothing to drive
export function driveAgent(blockId: string | undefined, data: string): void {
    if (!blockId) {
        return;
    }
    fireAndForget(() =>
        RpcApi.ControllerInputCommand(TabRpcClient, { blockid: blockId, inputdata64: stringToBase64(data) })
    );
}
