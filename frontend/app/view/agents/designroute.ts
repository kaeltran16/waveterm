// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Approve in a brainstorm pane and Build this… on a canvas hand an approved design on. A run waiting on this
// session takes it; any other session opens the launcher. The server looks the run up: the frontend's run lists
// are loaded per channel and could miss it.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { CREATE_RUN_TIMEOUT_MS } from "./runactions";

export type DesignAttach = (data: CommandRunDesignAttachData) => Promise<CommandRunDesignAttachRtnData>;

export type DesignRouteIO = {
    attach: DesignAttach;
    onAttached(channelId: string, runId: string): void;
    openLauncher(): void;
};

// the attach starts the run's lead before it replies, as CreateRun does, so it gets CreateRun's budget
export const tauriDesignAttach: DesignAttach = (data) =>
    RpcApi.RunDesignAttachCommand(TabRpcClient, data, { timeout: CREATE_RUN_TIMEOUT_MS });

// an attach the server refuses (a run already took this session's design) throws, and nothing opens
export async function routeDesign(
    io: DesignRouteIO,
    blockId: string,
    design: { spec?: string; prototype?: string }
): Promise<"attached" | "launcher"> {
    // the server refuses an empty design, which would leave an unlinked session's Approve opening nothing
    if (!design.spec && !design.prototype) {
        io.openLauncher();
        return "launcher";
    }
    const rtn = await io.attach({ blockid: blockId, spec: design.spec, prototype: design.prototype });
    if (rtn?.channelid && rtn?.runid) {
        io.onAttached(rtn.channelid, rtn.runid);
        return "attached";
    }
    io.openLauncher();
    return "launcher";
}
