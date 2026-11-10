// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The header's native model and permission-mode controls for a live claude session. The model rides /model through
// the same path as the composer; the permission mode has no command, so it types Shift+Tab into the terminal.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { stringToBase64 } from "@/util/util";
import { useAtomValue } from "jotai";
import { ChevronDown } from "lucide-react";
import { useRef, useState } from "react";
import { sendAgentText, toastSendFailure } from "./agentsend";
import type { AgentVM } from "./agentsviewmodel";
import {
    MODEL_ALIASES,
    modelCommand,
    PERMISSION_CYCLE,
    permissionModeKeys,
    permissionModeLabel,
} from "./headercontrolsmodel";
import { prettyModel } from "./modellabel";
import { getAgentStatusAtom, getLastHookAtom, getPermissionModeAtom } from "./session-models/agentstatusstore";

const KEY_GAP_MS = 60;

// hidden on a cramped header, as the view toggle is: the title keeps the room
const CONTROL_CLASS =
    "inline-flex shrink-0 items-center gap-[4px] whitespace-nowrap rounded-[5px] border border-edge-mid bg-surface-raised px-[7px] py-[1px] font-mono text-[10.5px] font-medium text-secondary @max-[560px]:hidden";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// one awaited write per key, so a failed write stops the sequence and reverts the optimistic mode
async function typeKeys(blockId: string, keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i++) {
        if (i > 0) {
            await sleep(KEY_GAP_MS);
        }
        await RpcApi.ControllerInputCommand(TabRpcClient, { blockid: blockId, inputdata64: stringToBase64(keys[i]) });
    }
}

export function HeaderControls({ agent }: { agent: AgentVM }) {
    const blockId = agent.blockId!;
    const oref = `block:${blockId}`;
    const status = useAtomValue(getAgentStatusAtom(oref));
    const reportedMode = useAtomValue(getPermissionModeAtom(oref));
    const lastHook = useAtomValue(getLastHookAtom(oref));
    // the optimistic mode holds until the next status lands, which carries the mode the TUI really has
    const [optimistic, setOptimistic] = useState<{ mode: string; hookTs?: number } | null>(null);
    const busy = useRef(false);
    const mode = optimistic != null && optimistic.hookTs === lastHook?.ts ? optimistic.mode : reportedMode;
    const modelLabel = (status?.model ? prettyModel(status.model) : (agent.model ?? "")).toLowerCase();

    const openModelMenu = (e: React.MouseEvent) => {
        const items: ContextMenuItem[] = MODEL_ALIASES.map((alias) => ({
            label: alias,
            click: () => {
                sendAgentText(blockId, modelCommand(alias)).catch((err) => toastSendFailure("Model not changed", err));
            },
        }));
        ContextMenuModel.getInstance().showContextMenu(items, e);
    };

    const changeMode = async (target: string) => {
        const keys = mode != null ? permissionModeKeys(mode, target) : null;
        if (keys == null || keys.length === 0 || busy.current) {
            return;
        }
        busy.current = true;
        setOptimistic({ mode: target, hookTs: globalStore.get(getLastHookAtom(oref))?.ts });
        try {
            await typeKeys(blockId, keys);
        } catch (err) {
            console.error("permission mode change failed", err);
            setOptimistic(null);
        } finally {
            busy.current = false;
        }
    };

    const openModeMenu = (e: React.MouseEvent) => {
        const items: ContextMenuItem[] = PERMISSION_CYCLE.map((m) => ({
            label: permissionModeLabel(m),
            type: "radio",
            checked: m === mode,
            click: () => void changeMode(m),
        }));
        ContextMenuModel.getInstance().showContextMenu(items, e);
    };

    // bypassPermissions or an unknown mode has no way to step around the cycle, so a chip would only be noise
    const changeable = mode != null && PERMISSION_CYCLE.includes(mode);
    const modeLabel = changeable ? permissionModeLabel(mode) : "";

    return (
        <>
            {modelLabel ? (
                <button
                    type="button"
                    data-header-model
                    aria-label={`Model: ${modelLabel}, change`}
                    onClick={openModelMenu}
                    className={`${CONTROL_CLASS} cursor-pointer hover:border-edge-strong`}
                >
                    {modelLabel}
                    <ChevronDown size={10} aria-hidden />
                </button>
            ) : null}
            {modeLabel ? (
                <button
                    type="button"
                    data-header-permission-mode
                    aria-label={`Permission mode: ${modeLabel}, change`}
                    onClick={openModeMenu}
                    className={`${CONTROL_CLASS} cursor-pointer hover:border-edge-strong`}
                >
                    {modeLabel}
                    <ChevronDown size={10} aria-hidden />
                </button>
            ) : null}
        </>
    );
}
