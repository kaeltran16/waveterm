// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The native model and permission-mode controls for a live claude session, drawn in the header or in the Rendered
// message box. The model rides /model through the same path as the composer; the permission mode has no command, so
// it types Shift+Tab into the terminal.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { stringToBase64 } from "@/util/util";
import { useAtomValue } from "jotai";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useRef } from "react";
import { sendAgentText, toastSendFailure } from "./agentsend";
import type { AgentVM } from "./agentsviewmodel";
import {
    MODEL_ALIASES,
    modelCommand,
    permissionCycle,
    permissionModeKeys,
    permissionModeLabel,
    shownPermissionMode,
} from "./headercontrolsmodel";
import { prettyModel } from "./modellabel";
import {
    autoPermissionSeenAtom,
    getAgentStatusAtom,
    getLastHookAtom,
    getOptimisticPermissionModeAtom,
    getPermissionModeAtom,
    getSeenPermissionModesAtom,
} from "./session-models/agentstatusstore";

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

// the model and permission-mode controls' labels and menus, shared by the header and the Rendered message box
function useAgentControls(agent: AgentVM) {
    const blockId = agent.blockId!;
    const oref = `block:${blockId}`;
    const status = useAtomValue(getAgentStatusAtom(oref));
    const reportedMode = useAtomValue(getPermissionModeAtom(oref));
    const lastHook = useAtomValue(getLastHookAtom(oref));
    const optimisticAtom = getOptimisticPermissionModeAtom(oref);
    const optimistic = useAtomValue(optimisticAtom);
    const cycle = permissionCycle(useAtomValue(getSeenPermissionModesAtom(oref)), useAtomValue(autoPermissionSeenAtom));
    const busy = useRef(false);
    const mode = shownPermissionMode(optimistic, lastHook?.ts, reportedMode);
    const model = status?.model ? prettyModel(status.model) : (agent.model ?? "");

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
        const keys = mode != null ? permissionModeKeys(cycle, mode, target) : null;
        if (keys == null || keys.length === 0 || busy.current) {
            return;
        }
        busy.current = true;
        globalStore.set(optimisticAtom, { mode: target, hookTs: globalStore.get(getLastHookAtom(oref))?.ts });
        try {
            await typeKeys(blockId, keys);
        } catch (err) {
            console.error("permission mode change failed", err);
            globalStore.set(optimisticAtom, null);
        } finally {
            busy.current = false;
        }
    };

    const openModeMenu = (e: React.MouseEvent) => {
        const items: ContextMenuItem[] = cycle.map((m) => ({
            label: permissionModeLabel(m),
            type: "radio",
            checked: m === mode,
            click: () => void changeMode(m),
        }));
        ContextMenuModel.getInstance().showContextMenu(items, e);
    };

    // bypassPermissions or an unknown mode has no way to step around the cycle, so a chip would only be noise
    const changeable = mode != null && cycle.includes(mode);
    const modeLabel = changeable ? permissionModeLabel(mode) : "";
    return { model, modeLabel, openModelMenu, openModeMenu };
}

export function HeaderControls({ agent }: { agent: AgentVM }) {
    const { model, modeLabel, openModelMenu, openModeMenu } = useAgentControls(agent);
    const modelLabel = model.toLowerCase();
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

const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// the same two controls drawn in the Rendered message box: the model as a pill (its menu opens upward), the mode plain
export function BoxControls({ agent }: { agent: AgentVM }) {
    const { model, modeLabel, openModelMenu, openModeMenu } = useAgentControls(agent);
    return (
        <>
            {model ? (
                <button
                    type="button"
                    data-composer-model
                    aria-label={`Model: ${model}, change`}
                    onClick={openModelMenu}
                    className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-edge-strong px-[11px] text-[12.5px] text-secondary hover:bg-surface-hover"
                >
                    {model}
                    <ChevronUp size={11} strokeWidth={2.4} aria-hidden className="text-muted" />
                </button>
            ) : null}
            {modeLabel ? (
                <button
                    type="button"
                    data-composer-permission-mode
                    aria-label={`Permission mode: ${modeLabel}, change`}
                    onClick={openModeMenu}
                    className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-[5px] whitespace-nowrap rounded-[7px] px-2 text-[12.5px] text-ink-mid hover:bg-surface-hover hover:text-secondary"
                >
                    {sentenceCase(modeLabel)}
                    <ChevronDown size={11} strokeWidth={2.4} aria-hidden className="text-muted" />
                </button>
            ) : null}
        </>
    );
}
